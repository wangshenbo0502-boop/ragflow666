/**
 * Chat completion SSE streaming.
 *
 * NOTE on the network layering convention (see web/AGENTS.md): this file
 * deliberately uses the native `fetch` API instead of the shared axios instance
 * in `@/utils/next-request`. Streaming requires access to the raw
 * `Response.body` `ReadableStream`, which axios cannot expose in the browser.
 * This mirrors the pre-existing SSE approach in `useSendMessageWithSse`
 * (`src/hooks/logic-hooks.ts`), but keeps `api.completionUrl` and the parsing
 * loop out of the hook layer.
 */
import { Authorization } from '@/constants/authorization';
import { IMessage, Variable } from '@/interfaces/database/chat';
import api from '@/utils/api';
import { getAuthorization } from '@/utils/authorization-util';
import { EventSourceParserStream } from 'eventsource-parser/stream';

export type ChatCompletionStreamParams = {
  messageId?: string;
  chatId?: string;
  sessionId: string;
  question: string;
  files?: IMessage['files'];
  enableThinking?: string;
  enableInternet?: boolean;
  llmSetting?: Variable;
  mode?: string;
  routePolicy?: string;
  editAssetId?: string;
};

export type CompletionChunk = {
  answer?: string;
  final?: boolean;
  start_to_think?: boolean;
  end_to_think?: boolean;
  [key: string]: any;
};

export class ChatCompletionStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatCompletionStreamError';
  }
}

function normalizeThinkingForRequest(thinking?: Variable['thinking']) {
  if (thinking === 'enabled' || thinking === 'disabled') return thinking;
  return undefined;
}

export function requestChatCompletionStream(
  {
    messageId,
    chatId,
    sessionId,
    question,
    files,
    enableThinking,
    enableInternet,
    llmSetting,
    mode,
    routePolicy,
    editAssetId,
  }: ChatCompletionStreamParams,
  signal: AbortSignal,
) {
  const {
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
    max_tokens,
    thinking,
  } = llmSetting ?? {};
  const requestThinking = normalizeThinkingForRequest(thinking);

  return fetch(api.completionUrl, {
    method: 'POST',
    headers: {
      [Authorization]: getAuthorization(),
      'Content-Type': 'application/json',
      ...(messageId
        ? { 'Idempotency-Key': `turn:${sessionId}:${messageId}` }
        : {}),
    },
    body: JSON.stringify({
      chat_id: chatId,
      session_id: sessionId,
      ...(messageId
        ? {
            messages: [
              { id: messageId, role: 'user', content: question, files },
            ],
          }
        : { question, files }),
      reasoning: Number(enableThinking),
      internet: enableInternet,
      mode,
      route_policy: routePolicy,
      edit_asset_id: editAssetId,
      ...(temperature === undefined ? {} : { temperature }),
      ...(top_p === undefined ? {} : { top_p }),
      ...(frequency_penalty === undefined ? {} : { frequency_penalty }),
      ...(presence_penalty === undefined ? {} : { presence_penalty }),
      ...(max_tokens === undefined ? {} : { max_tokens }),
      ...(requestThinking === undefined ? {} : { thinking: requestThinking }),
    }),
    signal,
  });
}

/**
 * Yields answer chunks and the server's explicit terminal event. Transport,
 * envelope, and payload failures are surfaced to the caller.
 */
export async function* parseCompletionEventStream(
  response: Response,
): AsyncGenerator<CompletionChunk | { streamTerminal: true }> {
  const reader = response.body
    ?.pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();

  if (!reader) return;

  // oxlint-disable-next-line no-constant-condition
  while (true) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw new ChatCompletionStreamError(
        'Chat response stream was interrupted',
      );
    }

    if (chunk.done) break;

    let payload: any;
    try {
      payload = JSON.parse(chunk.value?.data || '');
    } catch {
      throw new ChatCompletionStreamError(
        'Chat response contained an invalid event',
      );
    }

    if (!payload || typeof payload.code !== 'number') {
      throw new ChatCompletionStreamError(
        'Chat response contained an invalid envelope',
      );
    }
    if (payload.code !== 0) {
      throw new ChatCompletionStreamError(
        typeof payload.message === 'string' && payload.message
          ? payload.message
          : 'Chat request failed',
      );
    }

    const data = payload?.data;
    if (data === true) {
      yield { streamTerminal: true };
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ChatCompletionStreamError(
        'Chat response contained an invalid chunk',
      );
    }

    yield data as CompletionChunk;
  }
}
