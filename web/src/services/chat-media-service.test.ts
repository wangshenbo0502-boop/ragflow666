import { fetchChatAudio, fetchChatMedia } from './chat-media-service';

jest.mock('@/utils/authorization-util', () => ({
  getAuthorization: () => 'test-token',
}));

const src = '/api/v1/chats/chat/sessions/session/media/asset.wav';
function streamResponse(chunks: Uint8Array[], type = 'audio/wav') {
  const reader = {
    read: jest.fn(async () =>
      chunks.length ? { done: false, value: chunks.shift() } : { done: true },
    ),
    cancel: jest.fn(async () => {}),
    releaseLock: jest.fn(),
  };
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    headers: { get: (name: string) => (name === 'content-type' ? type : '1') },
    body: { getReader: () => reader, cancel: jest.fn() },
  });
  return reader;
}

it('reads a valid body incrementally and releases the stream lock', async () => {
  const reader = streamResponse([new Uint8Array([1, 2]), new Uint8Array([3])]);
  const result = await fetchChatAudio(src, new AbortController().signal);
  expect(result.size).toBe(3);
  expect(result.type).toBe('audio/wav');
  expect(reader.read).toHaveBeenCalledTimes(3);
  expect(reader.releaseLock).toHaveBeenCalledTimes(1);
});

it('stops at the byte limit despite a false Content-Length', async () => {
  const reader = streamResponse([
    new Uint8Array(32 * 1024 * 1024),
    new Uint8Array([1]),
    new Uint8Array([2]),
  ]);
  await expect(
    fetchChatMedia(src, new AbortController().signal),
  ).rejects.toThrow('size limit');
  expect(reader.read).toHaveBeenCalledTimes(2);
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(reader.releaseLock).toHaveBeenCalledTimes(1);
});

it('aborting during a read cancels without exposing the partial blob', async () => {
  const controller = new AbortController();
  const reader = streamResponse([]);
  reader.read.mockImplementationOnce(async () => {
    controller.abort();
    return { done: false, value: new Uint8Array([1]) };
  });
  await expect(fetchChatMedia(src, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(reader.cancel).toHaveBeenCalled();
  expect(reader.releaseLock).toHaveBeenCalledTimes(1);
});

it('rejects cross-origin resources before sending authorization', async () => {
  streamResponse([]);
  await expect(
    fetchChatMedia('https://other.invalid' + src, new AbortController().signal),
  ).rejects.toThrow('Invalid chat media');
  expect(fetch).not.toHaveBeenCalled();
});
