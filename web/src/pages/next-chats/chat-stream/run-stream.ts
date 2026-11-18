/**
 * Module-level SSE driver. Deliberately not a hook: it must keep running (and
 * keep writing into the store) after the chat page unmounts, so that navigating
 * away mid-answer and back shows the stream still in progress.
 */
import { IMessage, Variable } from '@/interfaces/database/chat';
import { ChatTask } from '@/interfaces/database/chat-task';
import {
  fetchChatTask,
  isChatTaskTerminal,
} from '@/services/chat-task-service';
import {
  CompletionChunk,
  parseCompletionEventStream,
  requestChatCompletionStream,
} from '@/services/chat-completion-stream';
import { mergeAnswerChunk } from '@/utils/chat';
import { AnswerFlushIntervalMs } from './constants';
import { useChatStreamStore } from './store';

export type RunChatCompletionStreamParams = {
  messageId?: string;
  conversationId: string;
  chatId?: string;
  question: string;
  files?: IMessage['files'];
  enableThinking?: string;
  enableInternet?: boolean;
  llmSetting?: Variable;
  mode?: string;
  routePolicy?: string;
  editAssetId?: string;
  onTaskUpdate?: (task: ChatTask) => void;
};

export type RunChatCompletionStreamResult = {
  /** The ordinary stream or the authoritative durable task completed successfully. */
  ok: boolean;
  /** Observation was stopped locally; an accepted server task is not cancelled. */
  aborted: boolean;
  /** A durable task ID was acknowledged, independently of its final outcome. */
  accepted: boolean;
  error?: string;
};

export async function runChatCompletionStream({
  messageId,
  conversationId,
  chatId,
  question,
  files,
  enableThinking,
  enableInternet,
  llmSetting,
  mode,
  routePolicy,
  editAssetId,
  onTaskUpdate,
}: RunChatCompletionStreamParams): Promise<RunChatCompletionStreamResult> {
  const { beginStream, applyAnswer, endStream } = useChatStreamStore.getState();

  const controller = new AbortController();
  if (!beginStream(conversationId, controller)) {
    return { ok: false, aborted: false, accepted: false };
  }

  // Kept local rather than read back from the store: it must stay immune to
  // concurrent mutations of the message list, and mergeAnswerChunk's
  // `startsWith` / think-marker behaviour depends on the raw accumulated text
  // rather than on the rendered message content.
  let accumulatedAnswer = '';
  let aborted = false;
  let ok = false;
  let acceptedTask: ChatTask | undefined;
  let errorMessage: string | undefined;

  // Chunks arrive faster than the UI can use them, so they're coalesced into a
  // single store write per AnswerFlushIntervalMs. Fields are merged rather than
  // replaced so a `reference` or `prompt` that arrived on a skipped chunk isn't
  // lost; the buffer resets on each flush, matching the legacy "newest chunk
  // wins" semantics across flush windows.
  let pendingChunk: CompletionChunk | undefined;
  let lastFlushAt = 0;

  const flushAnswer = () => {
    if (!pendingChunk) return;
    applyAnswer(conversationId, {
      ...pendingChunk,
      answer: accumulatedAnswer,
      conversationId,
    });
    pendingChunk = undefined;
    lastFlushAt = Date.now();
  };

  try {
    const response = await requestChatCompletionStream(
      {
        messageId,
        chatId,
        sessionId: conversationId,
        question,
        files,
        enableThinking,
        enableInternet,
        llmSetting,
        mode,
        routePolicy,
        editAssetId,
      },
      controller.signal,
    );

    const contentType =
      response.headers.get('content-type')?.toLowerCase() ?? '';
    if (
      !response.ok ||
      contentType.split(';', 1)[0].trim() !== 'text/event-stream'
    ) {
      let message = `Chat request failed (${response.status})`;
      try {
        const body = await response.json();
        if (typeof body?.message === 'string' && body.message) {
          message = body.message;
        }
      } catch {
        // Keep the status-based message when the error response is not JSON.
      }
      throw new Error(message);
    }

    let receivedTerminal = false;
    try {
      for await (const chunk of parseCompletionEventStream(response)) {
        if ('streamTerminal' in chunk) {
          receivedTerminal = true;
          continue;
        }
        if (chunk.task?.id) {
          if (!acceptedTask || chunk.task.revision > acceptedTask.revision) {
            acceptedTask = chunk.task as ChatTask;
            onTaskUpdate?.(acceptedTask);
          }
          continue;
        }
        accumulatedAnswer = mergeAnswerChunk(accumulatedAnswer, chunk);
        pendingChunk = pendingChunk ? { ...pendingChunk, ...chunk } : chunk;

        // The first chunk flushes immediately (lastFlushAt is 0), so the empty
        // placeholder is replaced without waiting out an interval.
        if (chunk.final || Date.now() - lastFlushAt >= AnswerFlushIntervalMs) {
          flushAnswer();
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        aborted = true;
      } else {
        throw error;
      }
    }
    ok =
      receivedTerminal &&
      !aborted &&
      (!acceptedTask || acceptedTask.state === 'succeeded');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      aborted = true;
    } else {
      ok = false;
      if (error instanceof Error) errorMessage = error.message;
    }
  } finally {
    // Whatever was buffered must land, including on abort: a stopped answer
    // keeps the text produced up to that point.
    flushAnswer();
    endStream(conversationId, !ok && !acceptedTask);
  }

  if (acceptedTask && !aborted && !isChatTaskTerminal(acceptedTask)) {
    // Observing a committed task never repeats the generation POST.
    try {
      const current = await fetchChatTask(acceptedTask.id);
      if (current.task.revision > acceptedTask.revision) {
        acceptedTask = current.task;
        onTaskUpdate?.(acceptedTask);
      }
      ok = acceptedTask.state === 'succeeded';
    } catch {
      // The task center keeps observing independently of this HTTP stream.
    }
  }
  if (acceptedTask && !aborted && isChatTaskTerminal(acceptedTask)) {
    ok = acceptedTask.state === 'succeeded';
  }
  return {
    ok,
    aborted,
    accepted: Boolean(acceptedTask),
    ...(!ok && !aborted && !acceptedTask && errorMessage
      ? { error: errorMessage }
      : {}),
  };
}
