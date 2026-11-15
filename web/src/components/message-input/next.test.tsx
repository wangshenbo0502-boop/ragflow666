import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { NextMessageInput } from './next';

jest.mock('@/components/file-upload', () => {
  const Wrapper = ({ children }: any) => <div>{children}</div>;
  return Object.fromEntries(
    [
      'FileUpload',
      'FileUploadDropzone',
      'FileUploadItem',
      'FileUploadItemDelete',
      'FileUploadItemMetadata',
      'FileUploadItemPreview',
      'FileUploadItemProgress',
      'FileUploadList',
      'FileUploadTrigger',
    ].map((name) => [name, Wrapper]),
  );
});
jest.mock('@/components/ui/textarea', () => {
  const React = require('react');
  return {
    Textarea: React.forwardRef((props: any, ref: any) => {
      const nativeProps = { ...props };
      delete nativeProps.autoSize;
      delete nativeProps.resize;
      return <textarea ref={ref} {...nativeProps} />;
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
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const Send = jest.fn();
function Composer({ initial = '@' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) =>
    setValue(event.target.value);
  return (
    <NextMessageInput
      mediaCommands
      value={value}
      onInputChange={handleChange}
      disabled={false}
      sendDisabled={false}
      sendLoading={false}
      conversationId="session"
      onPressEnter={Send}
      showUploadIcon={false}
    />
  );
}

beforeEach(() => jest.clearAllMocks());

it('selects a tool with arrows and Enter without sending', async () => {
  render(<Composer />);
  const input = screen.getByTestId('chat-textarea');
  expect(screen.getAllByRole('option')).toHaveLength(2);
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
  expect(input).toHaveValue('@生图 ');
  expect(Send).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '@生图 一列高铁' } });
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
  expect(Send).toHaveBeenCalledTimes(1);
});

it('filters and selects speech by click', () => {
  render(<Composer initial="@语" />);
  fireEvent.click(screen.getByRole('option', { name: '@语音' }));
  expect(screen.getByTestId('chat-textarea')).toHaveValue('@语音 ');
  expect(Send).not.toHaveBeenCalled();
});

it('does not intercept IME confirmation or ordinary mentions', () => {
  const { unmount } = render(<Composer />);
  fireEvent.keyDown(screen.getByTestId('chat-textarea'), {
    key: 'Enter',
    keyCode: 229,
    isComposing: true,
  });
  expect(Send).not.toHaveBeenCalled();
  expect(screen.getAllByRole('option')).toHaveLength(2);
  unmount();
  render(<Composer initial="解释 @生图" />);
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});
