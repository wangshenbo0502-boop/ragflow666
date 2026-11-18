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
function Composer({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) =>
    setValue(event.target.value);
  return (
    <NextMessageInput
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

it.each(['帮我生成一张高铁海报', '请用语音回复'])(
  'sends %s directly',
  async (initial) => {
    render(<Composer initial={initial} />);
    const input = screen.getByTestId('chat-textarea');
    expect(input).toHaveValue(initial);
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(Send).toHaveBeenCalledTimes(1);
  },
);

it('does not offer media commands when typing @', () => {
  render(<Composer initial="@" />);
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

it('does not send while confirming Chinese text with an IME', () => {
  render(<Composer initial="帮我生成一张" />);
  fireEvent.keyDown(screen.getByTestId('chat-textarea'), {
    key: 'Enter',
    keyCode: 229,
    isComposing: true,
  });
  expect(Send).not.toHaveBeenCalled();
});
