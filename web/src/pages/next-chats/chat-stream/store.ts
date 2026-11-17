/**
 * Module-level store for the single-chat SSE stream.
 *
 * The message list, the streaming flag and the AbortController live here rather
 * than in component state so an in-flight stream survives unmounting
 * `/chat/:id`. The reader loop (see run-stream.ts) writes straight into this
 * store, so navigating away and back re-subscribes to a stream that never
 * stopped.
 */
import { IAnswer, IMessage } from '@/interfaces/database/chat';
import { MessageType } from '@/constants/chat';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { MaxCachedChatSessions, EnableChatStreamDevtools } from './constants';
import {
  buildAssistantMessageFromAnswer,
  buildPrologueMessageId,
  buildQuestionAndPlaceholder,
  mergeLocalFiles,
} from './utils';

export type ChatStreamSession = {
  chatId: string;
  messages: IMessage[];
  isStreaming: boolean;
  abortController?: AbortController;
  // Text of a question whose stream failed. Held per session because the
  // failure can land while the user is on another conversation or page, where
  // restoring the input box directly would either be a no-op or type into the
  // wrong session's input.
  pendingInput?: string;
  interruptedTurnIds?: string[];
  lastActiveAt: number;
  serverRevision?: number;
  streamEndedAt?: number;
};

export type ChatStreamState = {
  sessions: Record<string, ChatStreamSession>;

  ensureSession(conversationId: string, chatId: string): void;
  seedPrologue(conversationId: string, chatId: string, prologue: string): void;
  hydrateFromServer(
    conversationId: string,
    messages: IMessage[],
    revision?: number,
    requestedAt?: number,
  ): void;
  appendQuestion(conversationId: string, message: IMessage): void;
  beginStream(conversationId: string, controller: AbortController): boolean;
  applyAnswer(conversationId: string, answer: IAnswer): void;
  failStream(conversationId: string, pendingInput: string): void;
  consumePendingInput(conversationId: string): void;
  removeMessageById(conversationId: string, messageId: string): void;
  endStream(conversationId: string, interrupted?: boolean): void;
  stopStream(conversationId: string): void;
  removeSessions(conversationIds: string[]): void;
};

function createSession(chatId: string): ChatStreamSession {
  return {
    chatId,
    messages: [],
    isStreaming: false,
    lastActiveAt: Date.now(),
  };
}

/**
 * Drops the least recently used idle sessions once the cache exceeds
 * MaxCachedChatSessions. Never evicts a streaming session or the session being
 * acted on. Only called from actions that can create a new entry — never from
 * the per-chunk hot path.
 */
function evictIdleSessions(
  sessions: Record<string, ChatStreamSession>,
  protectedId: string,
): Record<string, ChatStreamSession> {
  const ids = Object.keys(sessions);
  if (ids.length <= MaxCachedChatSessions) return sessions;

  const evictable = ids
    .filter((id) => id !== protectedId && !sessions[id].isStreaming)
    .sort((a, b) => sessions[a].lastActiveAt - sessions[b].lastActiveAt);

  const removeCount = ids.length - MaxCachedChatSessions;
  const next = { ...sessions };
  evictable.slice(0, removeCount).forEach((id) => {
    delete next[id];
  });
  return next;
}

function mergeInterruptedTurns(
  serverMessages: IMessage[],
  previous?: ChatStreamSession,
) {
  const retainedIds = new Set(previous?.interruptedTurnIds ?? []);
  if (!retainedIds.size) {
    return { messages: serverMessages, interruptedTurnIds: [] };
  }

  const messages = [...serverMessages];
  const stillInterrupted: string[] = [];
  for (const turnId of retainedIds) {
    const questionIndex = previous?.messages.findIndex(
      (message) => message.role === MessageType.User && message.id === turnId,
    );
    if (questionIndex === undefined || questionIndex < 0) continue;
    const question = previous!.messages[questionIndex];
    const answer = previous!.messages[questionIndex + 1];
    if (!answer || answer.role !== MessageType.Assistant) continue;

    const serverAnswer = messages.find(
      (message) =>
        message.role === MessageType.Assistant && message.id === turnId,
    );
    const serverVersion = (
      serverAnswer as (IMessage & { answer_version?: number }) | undefined
    )?.answer_version;
    const localVersion = (
      answer as IMessage & {
        answer_version?: number;
      }
    ).answer_version;
    if (
      serverAnswer &&
      Number(serverVersion ?? 0) >= Number(localVersion ?? 0)
    ) {
      continue;
    }

    stillInterrupted.push(turnId);
    const serverQuestionIndex = messages.findIndex(
      (message) => message.role === MessageType.User && message.id === turnId,
    );
    if (serverQuestionIndex >= 0) {
      const next = messages[serverQuestionIndex + 1];
      if (next?.role === MessageType.Assistant && next.id === turnId) {
        messages.splice(serverQuestionIndex, 2, question, answer);
      } else {
        messages[serverQuestionIndex] = question;
        messages.splice(serverQuestionIndex + 1, 0, answer);
      }
    } else {
      messages.splice(
        Math.min(questionIndex, messages.length),
        0,
        question,
        answer,
      );
    }
  }
  return { messages, interruptedTurnIds: stillInterrupted };
}

export const useChatStreamStore = create<ChatStreamState>()(
  devtools(
    (set, get) => ({
      sessions: {},

      ensureSession: (conversationId, chatId) => {
        if (!conversationId) return;
        if (get().sessions[conversationId]) return;
        set(
          (state) => ({
            sessions: evictIdleSessions(
              {
                ...state.sessions,
                [conversationId]: createSession(chatId),
              },
              conversationId,
            ),
          }),
          false,
          'ensureSession',
        );
      },

      seedPrologue: (conversationId, chatId, prologue) => {
        if (!conversationId) return;
        const session = get().sessions[conversationId];
        // Idempotent: a session that already holds messages (a seeded prologue
        // under StrictMode's double effect, or a real exchange) is left alone.
        if (session && session.messages.length > 0) return;

        const prologueMessage: IMessage = {
          role: MessageType.Assistant,
          content: prologue,
          id: buildPrologueMessageId(conversationId),
          conversationId,
        };

        set(
          (state) => ({
            sessions: evictIdleSessions(
              {
                ...state.sessions,
                [conversationId]: {
                  ...(state.sessions[conversationId] ?? createSession(chatId)),
                  messages: [prologueMessage],
                  lastActiveAt: Date.now(),
                },
              },
              conversationId,
            ),
          }),
          false,
          'seedPrologue',
        );
      },

      hydrateFromServer: (conversationId, messages, revision, requestedAt) => {
        if (!conversationId) return;
        const session = get().sessions[conversationId];
        // A stream in flight owns the list: the answer it is building hasn't
        // been persisted yet, so anything the server returns is behind.
        if (session?.isStreaming) return;
        if (revision !== undefined && revision < (session?.serverRevision ?? 0))
          return;
        if (
          requestedAt !== undefined &&
          requestedAt < (session?.streamEndedAt ?? 0)
        )
          return;

        set(
          (state) => {
            const previous = state.sessions[conversationId];
            const merged = mergeInterruptedTurns(messages, previous);
            return {
              sessions: evictIdleSessions(
                {
                  ...state.sessions,
                  [conversationId]: {
                    ...(previous ?? createSession('')),
                    messages: mergeLocalFiles(
                      merged.messages,
                      previous?.messages ?? [],
                    ),
                    interruptedTurnIds: merged.interruptedTurnIds,
                    serverRevision: revision ?? previous?.serverRevision,
                    lastActiveAt: Date.now(),
                  },
                },
                conversationId,
              ),
            };
          },
          false,
          'hydrateFromServer',
        );
      },

      appendQuestion: (conversationId, message) => {
        if (!conversationId) return;
        set(
          (state) => {
            const previous =
              state.sessions[conversationId] ?? createSession('');
            return {
              sessions: evictIdleSessions(
                {
                  ...state.sessions,
                  [conversationId]: {
                    ...previous,
                    messages: [
                      ...previous.messages,
                      ...buildQuestionAndPlaceholder(message),
                    ],
                    lastActiveAt: Date.now(),
                  },
                },
                conversationId,
              ),
            };
          },
          false,
          'appendQuestion',
        );
      },

      beginStream: (conversationId, controller) => {
        if (!conversationId) return false;
        // Guard against a duplicate start (StrictMode, double submit).
        if (get().sessions[conversationId]?.isStreaming) return false;

        set(
          (state) => {
            const previous =
              state.sessions[conversationId] ?? createSession('');
            return {
              sessions: {
                ...state.sessions,
                [conversationId]: {
                  ...previous,
                  isStreaming: true,
                  abortController: controller,
                  lastActiveAt: Date.now(),
                },
              },
            };
          },
          false,
          'beginStream',
        );
        return true;
      },

      applyAnswer: (conversationId, answer) => {
        if (!conversationId) return;
        set(
          (state) => {
            const previous = state.sessions[conversationId];
            if (!previous) return state;
            // A session that is no longer streaming has no trailing placeholder
            // to fill in. The reader's final flush runs before endStream, so
            // this also guards the case where the in-flight question (and its
            // placeholder) were just deleted: without it, the flush would slice
            // off whatever message is now last.
            if (!previous.isStreaming) return state;
            const messages = previous.messages.slice(0, -1);
            const question = messages.at(-1);
            const completedQuestion =
              question?.role === MessageType.User ? question : undefined;
            // The server assigns the turn ID for question-only requests.
            // Keep the local question and streamed answer paired under that ID.
            if (
              answer.id &&
              question?.role === MessageType.User &&
              question.id !== answer.id
            ) {
              messages[messages.length - 1] = {
                ...question,
                id: answer.id,
              };
            }
            messages.push(buildAssistantMessageFromAnswer(answer));
            const supersededTurnIds = new Set(
              (previous.interruptedTurnIds ?? []).filter((turnId) => {
                const interruptedQuestion = previous.messages.find(
                  (message) =>
                    message.role === MessageType.User && message.id === turnId,
                );
                return (
                  completedQuestion &&
                  interruptedQuestion?.content === completedQuestion.content
                );
              }),
            );
            const nextMessages = supersededTurnIds.size
              ? messages.filter((message) => !supersededTurnIds.has(message.id))
              : messages;
            return {
              sessions: {
                ...state.sessions,
                [conversationId]: {
                  ...previous,
                  messages: nextMessages,
                  interruptedTurnIds: (
                    previous.interruptedTurnIds ?? []
                  ).filter((turnId) => !supersededTurnIds.has(turnId)),
                  lastActiveAt: Date.now(),
                },
              },
            };
          },
          false,
          'applyAnswer',
        );
      },

      // Keep received output; return the failed question to its own input.
      failStream: (conversationId, pendingInput) => {
        if (!conversationId) return;
        set(
          (state) => {
            const previous = state.sessions[conversationId];
            if (!previous) return state;
            return {
              sessions: {
                ...state.sessions,
                [conversationId]: {
                  ...previous,
                  messages: previous.messages.at(-1)?.content
                    ? previous.messages
                    : previous.messages.slice(0, -2),
                  pendingInput,
                },
              },
            };
          },
          false,
          'failStream',
        );
      },

      consumePendingInput: (conversationId) => {
        if (!conversationId) return;
        set(
          (state) => {
            const previous = state.sessions[conversationId];
            if (!previous?.pendingInput) return state;
            return {
              sessions: {
                ...state.sessions,
                [conversationId]: { ...previous, pendingInput: undefined },
              },
            };
          },
          false,
          'consumePendingInput',
        );
      },

      removeMessageById: (conversationId, messageId) => {
        if (!conversationId) return;

        // Deleting the question that is currently being answered has to stop
        // that answer too: the stream lives at module level, so it would
        // otherwise keep producing tokens for a question that is gone. The
        // question and its assistant placeholder are appended as a pair (and
        // share an id), so the in-flight question sits second to last.
        const session = get().sessions[conversationId];
        const removingStreamedQuestion = Boolean(
          session?.isStreaming && session.messages.at(-2)?.id === messageId,
        );
        if (removingStreamedQuestion) {
          session?.abortController?.abort();
        }

        set(
          (state) => {
            const previous = state.sessions[conversationId];
            if (!previous) return state;
            return {
              sessions: {
                ...state.sessions,
                [conversationId]: {
                  ...previous,
                  messages: previous.messages.filter((x) => x.id !== messageId),
                  // Close the session right here instead of waiting for the
                  // reader's endStream, so the abort's trailing flush can't
                  // write the deleted answer back into the list.
                  isStreaming: removingStreamedQuestion
                    ? false
                    : previous.isStreaming,
                  abortController: removingStreamedQuestion
                    ? undefined
                    : previous.abortController,
                },
              },
            };
          },
          false,
          'removeMessageById',
        );
      },

      endStream: (conversationId, interrupted = false) => {
        if (!conversationId) return;
        set(
          (state) => {
            const previous = state.sessions[conversationId];
            if (!previous) return state;
            const answer = previous.messages.at(-1);
            const question = previous.messages.at(-2);
            const interruptedTurnIds = new Set(previous.interruptedTurnIds);
            if (
              interrupted &&
              answer?.role === MessageType.Assistant &&
              answer.content &&
              question?.role === MessageType.User &&
              answer.id === question.id
            ) {
              interruptedTurnIds.add(question.id);
            }
            return {
              sessions: {
                ...state.sessions,
                [conversationId]: {
                  ...previous,
                  isStreaming: false,
                  abortController: undefined,
                  interruptedTurnIds: [...interruptedTurnIds],
                  streamEndedAt: Date.now(),
                },
              },
            };
          },
          false,
          'endStream',
        );
      },

      stopStream: (conversationId) => {
        if (!conversationId) return;
        get().sessions[conversationId]?.abortController?.abort();
      },

      removeSessions: (conversationIds) => {
        if (conversationIds.length === 0) return;
        set(
          (state) => {
            const sessions = { ...state.sessions };
            conversationIds.forEach((id) => {
              sessions[id]?.abortController?.abort();
              delete sessions[id];
            });
            return { sessions };
          },
          false,
          'removeSessions',
        );
      },
    }),
    { name: 'chat-stream', enabled: EnableChatStreamDevtools },
  ),
);

// Shared empty array so a session-less selector keeps returning the same
// reference and doesn't trigger re-renders.
const EmptyMessages: IMessage[] = [];

export function useChatStreamMessages(conversationId: string) {
  return useChatStreamStore(
    (state) => state.sessions[conversationId]?.messages ?? EmptyMessages,
  );
}

export function useIsChatStreaming(conversationId: string) {
  return useChatStreamStore(
    (state) => state.sessions[conversationId]?.isStreaming ?? false,
  );
}

export function useChatPendingInput(conversationId: string) {
  return useChatStreamStore(
    (state) => state.sessions[conversationId]?.pendingInput,
  );
}
