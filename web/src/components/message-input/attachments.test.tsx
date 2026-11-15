import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import { NextMessageInput } from './next';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/components/ui/textarea', () => {
  const React = require('react');
  return {
    Textarea: React.forwardRef((props: any, ref: any) => {
      const native = { ...props };
      delete native.autoSize;
      delete native.resize;
      return <textarea ref={ref} {...native} />;
    }),
  };
});
jest.mock('@/hooks/use-thinking-level', () => ({
  setThinkingLevel: jest.fn(),
  useThinkingLevel: () => '0',
  ThinkingMode: {},
}));
jest.mock('../originui/select-with-search', () => ({
  SelectWithSearch: () => null,
}));

const Send = jest.fn();
const Upload = jest.fn();
const Stop = jest.fn();
function Composer({
  uploading = false,
  streaming = false,
  session = 'session',
}) {
  const [value, setValue] = useState('');
  return (
    <NextMessageInput
      value={value}
      onInputChange={(event) => setValue(event.target.value)}
      disabled={false}
      sendDisabled={false}
      sendLoading={streaming}
      stopOutputMessage={Stop}
      isUploading={uploading}
      conversationId={session}
      onPressEnter={Send}
      onUpload={Upload}
    />
  );
}
const AddFile = (container: HTMLElement, file: File) =>
  fireEvent.change(container.querySelector('input[type=file]')!, {
    target: { files: [file] },
  });

beforeEach(() => {
  jest.resetAllMocks();
  URL.createObjectURL = jest.fn(() => 'blob:preview');
  URL.revokeObjectURL = jest.fn();
});

it('keeps stopping available while uploads and input are disabled during generation', () => {
  const { container } = render(<Composer streaming />);
  const stop = screen.getByTestId('chat-stream-status');
  expect(stop.closest('form')).toHaveAttribute('aria-disabled', 'false');
  expect(stop.closest('form')).not.toHaveAttribute('data-disabled');
  expect(screen.getByTestId('chat-textarea')).toBeDisabled();
  expect(container.querySelector('input[type=file]')).toBeDisabled();
  fireEvent.click(stop);
  expect(Stop).toHaveBeenCalledTimes(1);
});

it('keeps attachments when a send is rejected and prevents duplicate submits while creating a session', async () => {
  Upload.mockImplementation((files, options) =>
    files.forEach(options.onSuccess),
  );
  let accept: (accepted: boolean) => void = () => {};
  Send.mockImplementation(
    () => new Promise<boolean>((resolve) => (accept = resolve)),
  );
  const { container } = render(<Composer />);
  AddFile(container, new File(['notes'], 'keep.txt', { type: 'text/plain' }));
  const send = screen.getByTestId('chat-detail-send');
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  fireEvent.click(send);
  expect(Send).toHaveBeenCalledTimes(1);
  await act(async () => accept(false));
  expect(screen.getByText('keep.txt')).toBeInTheDocument();
  fireEvent.click(send);
  expect(Send).toHaveBeenCalledTimes(2);
  await act(async () => accept(true));
  expect(screen.queryByText('keep.txt')).not.toBeInTheDocument();
});

it('keeps the input editable during uploads and sends attachment-only messages after success', async () => {
  let complete: () => void = () => {};
  Upload.mockImplementation(
    (files, options) =>
      new Promise<void>((resolve) => {
        complete = () => {
          files.forEach(options.onSuccess);
          resolve();
        };
      }),
  );
  const { container, rerender } = render(<Composer uploading />);
  const input = screen.getByTestId('chat-textarea');
  expect(input).toBeEnabled();
  fireEvent.change(input, { target: { value: '修改成蓝底' } });
  expect(input).toHaveValue('修改成蓝底');
  AddFile(
    container,
    new File(['photo'], 'portrait.png', { type: 'image/png' }),
  );
  await waitFor(() => expect(Upload).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('chat-detail-send')).toBeDisabled();
  fireEvent.change(input, { target: { value: '' } });
  await act(async () => complete());
  rerender(<Composer />);
  expect(screen.getByTestId('chat-detail-send')).toBeEnabled();
  await act(async () =>
    fireEvent.click(screen.getByTestId('chat-detail-send')),
  );
  expect(Send).toHaveBeenCalledTimes(1);
});

it('blocks failed attachments, retries failures, and clears attachments on session changes', async () => {
  Upload.mockRejectedValueOnce(new Error('Network Error'));
  Upload.mockImplementationOnce((files, options) =>
    files.forEach(options.onSuccess),
  );
  const { container, rerender } = render(<Composer />);
  AddFile(
    container,
    new File(['content'], 'notes.txt', { type: 'text/plain' }),
  );
  const retry = await screen.findByRole('button', {
    name: 'chat.retryAttachment',
  });
  expect(screen.getByTestId('chat-detail-send')).toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() =>
    expect(screen.getByTestId('chat-detail-send')).toBeEnabled(),
  );
  expect(Upload).toHaveBeenCalledTimes(2);
  rerender(<Composer session="other" />);
  expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
});

it('preserves normal text paste and does not open the file chooser on text entry', () => {
  const { container } = render(<Composer />);
  const input = screen.getByTestId('chat-textarea');
  const chooser = container.querySelector('input[type=file]')!;
  expect(chooser).toHaveAttribute('multiple');
  const click = jest.spyOn(chooser as HTMLInputElement, 'click');
  fireEvent.click(input);
  fireEvent.keyDown(input, { key: ' ' });
  expect(click).not.toHaveBeenCalled();
  expect(
    fireEvent.paste(input, {
      clipboardData: { files: [], items: [], getData: () => 'text' },
    }),
  ).toBe(true);
});
