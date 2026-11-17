import { Authorization } from '@/constants/authorization';
import { getAuthorization } from '@/utils/authorization-util';

export async function fetchChatMedia(src: string, signal: AbortSignal) {
  const url = new URL(src, window.location.origin);
  if (
    url.origin !== window.location.origin ||
    !/^\/api\/v1\/chats\/[^/]+\/sessions\/[^/]+\/media\/[^/]+$/.test(
      url.pathname,
    )
  ) {
    throw new Error('Invalid chat media resource');
  }
  const response = await fetch(url, {
    headers: { [Authorization]: getAuthorization() },
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error('Media unavailable');
  const type =
    response.headers.get('content-type')?.split(';', 1)[0].trim() ?? '';
  const limit = 32 * 1024 * 1024;
  if (!/^(audio|image)\//.test(type) || !response.body) {
    await response.body?.cancel();
    throw new Error('Invalid media response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Media exceeds size limit');
      chunks.push(new Uint8Array(value));
    }
    if (!bytes) throw new Error('Invalid media response');
    return new Blob(chunks, { type });
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export async function fetchChatAudio(src: string, signal: AbortSignal) {
  const blob = await fetchChatMedia(src, signal);
  if (!blob.type.startsWith('audio/'))
    throw new Error('Invalid audio response');
  return blob;
}

export async function downloadChatMedia(src: string, signal: AbortSignal) {
  const blob = await fetchChatMedia(src, signal);
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = new URL(src, window.location.origin).pathname
    .split('/')
    .pop()!;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
