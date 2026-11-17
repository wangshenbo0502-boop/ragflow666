import { act, renderHook } from '@testing-library/react';
import { useSpeech } from './use-speech';
import { fetchChatAudio } from '@/services/chat-media-service';
import chatService from '@/services/next-chat-service';

jest.mock('@/services/chat-media-service', () => ({
  fetchChatAudio: jest.fn(),
}));
jest.mock('@/services/next-chat-service', () => ({
  __esModule: true,
  default: { chatsTts: jest.fn() },
}));
jest.mock('@/utils/notification', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  URL.createObjectURL = jest.fn(() => 'blob:audio');
  URL.revokeObjectURL = jest.fn();
});

function mountAudio(hook: {
  result: { current: { ref: { current: HTMLAudioElement | null } } };
}) {
  const audio = { play: jest.fn(async () => {}), pause: jest.fn(), src: '' };
  Object.assign(hook.result.current.ref, { current: audio });
  return audio;
}

it('plays an existing audio resource without synthesizing and releases its URL', async () => {
  jest
    .mocked(fetchChatAudio)
    .mockResolvedValue(new Blob(['audio'], { type: 'audio/wav' }));
  const hook = renderHook(() =>
    useSpeech('answer', undefined, '/api/v1/chats/c/sessions/s/media/a.wav'),
  );
  const audio = mountAudio(hook);
  await act(() => hook.result.current.handleRead());
  expect(audio.play).toHaveBeenCalledTimes(1);
  expect(chatService.chatsTts).not.toHaveBeenCalled();
  hook.unmount();
  expect(audio.pause).toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audio');
});

it('stops the first message when another message plays its existing audio', async () => {
  jest
    .mocked(fetchChatAudio)
    .mockResolvedValue(new Blob(['audio'], { type: 'audio/wav' }));
  const first = renderHook(() =>
    useSpeech('first answer', undefined, '/first.wav'),
  );
  const second = renderHook(() =>
    useSpeech('second answer', undefined, '/second.wav'),
  );
  const firstAudio = mountAudio(first);
  const secondAudio = mountAudio(second);
  await act(() => first.result.current.handleRead());
  expect(first.result.current.isPlaying).toBe(true);
  await act(() => second.result.current.handleRead());
  expect(firstAudio.pause).toHaveBeenCalledTimes(1);
  expect(first.result.current.isPlaying).toBe(false);
  expect(second.result.current.isPlaying).toBe(true);
  first.unmount();
  expect(secondAudio.pause).not.toHaveBeenCalled();
  await act(() => second.result.current.handleRead());
  expect(secondAudio.pause).toHaveBeenCalledTimes(1);
  expect(second.result.current.isPlaying).toBe(false);
  expect(chatService.chatsTts).not.toHaveBeenCalled();
  second.unmount();
});

it('aborts an older synthesis so a late response cannot interrupt the new playback', async () => {
  let resolveFirst!: (value: { data: Blob }) => void;
  jest
    .mocked(chatService.chatsTts)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }) as never,
    )
    .mockResolvedValueOnce({
      data: new Blob(['audio'], { type: 'audio/wav' }),
    } as never);
  const first = renderHook(() => useSpeech('first'));
  const firstAudio = mountAudio(first);
  let pending!: Promise<void>;
  act(() => {
    pending = first.result.current.handleRead();
  });
  const second = renderHook(() => useSpeech('second'));
  const secondAudio = mountAudio(second);
  await act(() => second.result.current.handleRead());
  await act(async () => {
    resolveFirst({ data: new Blob(['late'], { type: 'audio/wav' }) });
    await pending;
  });
  expect(firstAudio.play).not.toHaveBeenCalled();
  expect(secondAudio.play).toHaveBeenCalledTimes(1);
  first.unmount();
  second.unmount();
});

it('keeps a restarted playback running when the previous play promise resolves late', async () => {
  jest
    .mocked(fetchChatAudio)
    .mockResolvedValue(new Blob(['audio'], { type: 'audio/wav' }));
  const hook = renderHook(() => useSpeech('answer', undefined, '/audio.wav'));
  const audio = mountAudio(hook);
  let finishFirstPlay!: () => void;
  audio.play.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFirstPlay = resolve;
      }),
  );
  let firstRead!: Promise<void>;
  await act(async () => {
    firstRead = hook.result.current.handleRead();
    await Promise.resolve();
  });
  expect(audio.play).toHaveBeenCalledTimes(1);
  await act(() => hook.result.current.handleRead());
  expect(audio.pause).toHaveBeenCalledTimes(1);
  await act(() => hook.result.current.handleRead());
  expect(audio.play).toHaveBeenCalledTimes(2);
  expect(hook.result.current.isPlaying).toBe(true);
  await act(async () => {
    finishFirstPlay();
    await firstRead;
  });
  expect(audio.pause).toHaveBeenCalledTimes(1);
  expect(hook.result.current.isPlaying).toBe(true);
  hook.unmount();
});
