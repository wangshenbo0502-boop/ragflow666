import { act, renderHook } from '@testing-library/react';
import {
  useUploadAndParseFile,
  useGetChatSearchParams,
} from '@/hooks/use-chat-request';
import { useUploadFile } from './use-upload-file';

jest.mock('@/hooks/use-chat-request', () => ({
  useGetChatSearchParams: jest.fn(),
  useUploadAndParseFile: jest.fn(),
}));

const uploadAndParseFile = jest.fn();
const cancel = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (useGetChatSearchParams as jest.Mock).mockReturnValue({
    conversationId: 'conversation',
  });
  (useUploadAndParseFile as jest.Mock).mockReturnValue({
    uploadAndParseFile,
    cancel,
  });
});

it('keeps selection order when a failed upload is retried', async () => {
  const first = new File(['first'], 'first.png', { type: 'image/png' });
  const second = new File(['second'], 'second.png', { type: 'image/png' });
  uploadAndParseFile
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({
      code: 0,
      data: { id: 'second-upload', name: 'second.png' },
    })
    .mockResolvedValueOnce({
      code: 0,
      data: { id: 'first-upload', name: 'first.png' },
    });

  const { result } = renderHook(() => useUploadFile());

  await act(async () => {
    await result.current.handleUploadFile([first, second], {} as never);
  });
  expect(result.current.files.map(({ id }) => id)).toEqual(['second-upload']);

  await act(async () => {
    await result.current.handleUploadFile([first], {} as never);
  });
  expect(result.current.files.map(({ id }) => id)).toEqual([
    'first-upload',
    'second-upload',
  ]);
});

it('preserves the remaining selection order after removing an uploaded file', async () => {
  const first = new File(['first'], 'first.png', { type: 'image/png' });
  const second = new File(['second'], 'second.png', { type: 'image/png' });
  uploadAndParseFile
    .mockResolvedValueOnce({
      code: 0,
      data: { id: 'first-upload', name: 'first.png' },
    })
    .mockResolvedValueOnce({
      code: 0,
      data: { id: 'second-upload', name: 'second.png' },
    });

  const { result } = renderHook(() => useUploadFile());

  await act(async () => {
    await result.current.handleUploadFile([first, second], {} as never);
  });
  act(() => result.current.removeFile(first));

  expect(result.current.files.map(({ id }) => id)).toEqual(['second-upload']);
});

it('does not restore a file removed while its upload is pending', async () => {
  const file = new File(['image'], 'image.png', { type: 'image/png' });
  let finish!: (value: unknown) => void;
  uploadAndParseFile.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const { result } = renderHook(() => useUploadFile());
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.handleUploadFile([file], {} as never);
  });
  act(() => result.current.removeFile(file));
  await act(async () => {
    finish({ code: 0, data: { id: 'deleted-upload' } });
    await pending;
  });
  expect(result.current.files).toEqual([]);
  expect(result.current.isUploading).toBe(false);
});

it('isolates new-session uploads from an unresolved previous-session queue', async () => {
  const oldFile = new File(['old'], 'old.png');
  const newFile = new File(['new'], 'new.png');
  let finish!: (value: unknown) => void;
  uploadAndParseFile
    .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    .mockResolvedValueOnce({ code: 0, data: { id: 'new-upload' } });
  const { result, rerender } = renderHook(() => useUploadFile());
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.handleUploadFile([oldFile], {} as never);
  });
  (useGetChatSearchParams as jest.Mock).mockReturnValue({
    conversationId: 'new-session',
  });
  rerender();
  expect(result.current.isUploading).toBe(false);
  await act(async () => {
    await result.current.handleUploadFile([newFile], {} as never);
  });
  expect(result.current.files.map(({ id }) => id)).toEqual(['new-upload']);
  await act(async () => {
    finish({ code: 0, data: { id: 'late-old-upload' } });
    await pending;
  });
  expect(result.current.files.map(({ id }) => id)).toEqual(['new-upload']);
  expect(result.current.isUploading).toBe(false);
  expect(cancel).toHaveBeenCalled();
});
