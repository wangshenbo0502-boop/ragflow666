import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ChatMediaAudio } from './chat-media-audio';
import { fetchChatAudio } from '@/services/chat-media-service';

jest.mock('@/services/chat-media-service', () => ({
  fetchChatAudio: jest.fn(),
  downloadChatMedia: jest.fn(),
}));
jest.mock('@/components/ui/slider', () => ({ Slider: () => null }));

function deferred() {
  let resolve!: (blob: Blob) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Blob>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  URL.createObjectURL = jest.fn(() => 'blob:audio');
  URL.revokeObjectURL = jest.fn();
});
afterEach(() => jest.restoreAllMocks());

it.each(['resolve', 'reject'] as const)(
  'late A %s cannot interrupt the newer B intent',
  async (outcome) => {
    const a = deferred();
    const b = deferred();
    (fetchChatAudio as jest.Mock)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    render(
      <>
        <section data-testid="a">
          <ChatMediaAudio src="/a" />
        </section>
        <section data-testid="b">
          <ChatMediaAudio src="/b" />
        </section>
      </>,
    );
    const first = within(screen.getByTestId('a'));
    const second = within(screen.getByTestId('b'));
    fireEvent.click(first.getByRole('button', { name: '播放语音' }));
    const firstSignal = (fetchChatAudio as jest.Mock).mock
      .calls[0][1] as AbortSignal;
    fireEvent.click(second.getByRole('button', { name: '播放语音' }));
    expect(firstSignal.aborted).toBe(true);
    await act(async () => b.resolve(new Blob(['B'], { type: 'audio/wav' })));
    expect(second.getByRole('status')).toHaveTextContent('播放中');
    await act(async () => {
      if (outcome === 'resolve') a.resolve(new Blob(['A']));
      else a.reject(new Error('old fetch failed'));
    });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(second.getByRole('status')).toHaveTextContent('播放中');
    expect(first.getByRole('status')).toHaveTextContent('语音');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  },
);

it('pausing a pending fetch cancels its intent and ignores the late result', async () => {
  const request = deferred();
  (fetchChatAudio as jest.Mock).mockReturnValue(request.promise);
  render(<ChatMediaAudio src="/a" />);
  fireEvent.click(screen.getByRole('button', { name: '播放语音' }));
  fireEvent.click(screen.getByRole('button', { name: '暂停' }));
  expect((fetchChatAudio as jest.Mock).mock.calls[0][1].aborted).toBe(true);
  await act(async () => request.resolve(new Blob(['A'])));
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('语音');
});

it('resource changes and unmount cancel their own fetch and revoke completed URLs', async () => {
  const old = deferred();
  (fetchChatAudio as jest.Mock)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(new Blob(['B']));
  const { rerender, unmount } = render(<ChatMediaAudio src="/a" />);
  fireEvent.click(screen.getByRole('button', { name: '播放语音' }));
  rerender(<ChatMediaAudio src="/b" />);
  expect((fetchChatAudio as jest.Mock).mock.calls[0][1].aborted).toBe(true);
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: '播放语音' })),
  );
  await act(async () => old.reject(new Error('old failure')));
  expect(screen.getByRole('status')).toHaveTextContent('播放中');
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audio');
});
