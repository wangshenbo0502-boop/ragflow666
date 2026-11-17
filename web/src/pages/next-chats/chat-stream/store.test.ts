import { MessageType } from '@/constants/chat';
import { IMessage } from '@/interfaces/database/chat';
import { useChatStreamStore } from './store';

const conversationId = 'interrupted-session';
const chatId = 'chat';

function startTurn(id: string, content: string) {
  const store = useChatStreamStore.getState();
  store.appendQuestion(conversationId, {
    id,
    role: MessageType.User,
    content,
    conversationId,
  } as IMessage);
  store.beginStream(conversationId, new AbortController());
}

function interruptTurn(id: string, content: string) {
  startTurn(id, content);
  const store = useChatStreamStore.getState();
  store.applyAnswer(conversationId, {
    id,
    answer: 'partial answer',
    answer_version: 1,
    reference: { chunks: [{ content: 'partial citation' }] },
  } as any);
  store.endStream(conversationId, true);
  store.failStream(conversationId, content);
}

beforeEach(() => {
  useChatStreamStore.getState().removeSessions([conversationId]);
  useChatStreamStore.getState().ensureSession(conversationId, chatId);
});

it('retains an interrupted answer and citation over stale server snapshots', () => {
  interruptTurn('turn-1', 'question');

  useChatStreamStore
    .getState()
    .hydrateFromServer(conversationId, [], 2, Date.now());

  const messages =
    useChatStreamStore.getState().sessions[conversationId].messages;
  expect(messages.map(({ content }) => content)).toEqual([
    'question',
    'partial answer',
  ]);
  expect(messages[1].reference).toEqual({
    chunks: [{ content: 'partial citation' }],
  });
  expect(
    useChatStreamStore.getState().sessions[conversationId].pendingInput,
  ).toBe('question');
});

it('replaces the retained draft when the server has a newer answer version', () => {
  interruptTurn('turn-1', 'question');

  useChatStreamStore.getState().hydrateFromServer(
    conversationId,
    [
      { id: 'turn-1', role: MessageType.User, content: 'question' },
      {
        id: 'turn-1',
        role: MessageType.Assistant,
        content: 'authoritative answer',
        answer_version: 2,
        reference: { chunks: [{ content: 'new citation' }] },
      },
    ] as IMessage[],
    3,
    Date.now(),
  );

  const session = useChatStreamStore.getState().sessions[conversationId];
  expect(session.messages.at(-1)?.content).toBe('authoritative answer');
  expect(session.messages.at(-1)?.reference).toEqual({
    chunks: [{ content: 'new citation' }],
  });
  expect(session.interruptedTurnIds).toEqual([]);
});

it('retains explicitly stopped output across polls without restoring the question', () => {
  startTurn('turn-1', 'question');
  const store = useChatStreamStore.getState();
  store.applyAnswer(conversationId, {
    id: 'turn-1',
    answer: 'stopped answer',
    answer_version: 2,
  } as any);
  store.endStream(conversationId, true);

  for (const revision of [2, 3]) {
    store.hydrateFromServer(
      conversationId,
      [
        { id: 'turn-1', role: MessageType.User, content: 'question' },
        {
          id: 'turn-1',
          role: MessageType.Assistant,
          content: 'older answer',
          answer_version: 1,
        },
      ] as IMessage[],
      revision,
      Date.now(),
    );
  }

  const session = useChatStreamStore.getState().sessions[conversationId];
  expect(session.messages.at(-1)?.content).toBe('stopped answer');
  expect(session.pendingInput).toBeUndefined();
  expect(session.isStreaming).toBe(false);
});

it('does not protect a placeholder with no received output', () => {
  startTurn('turn-1', 'question');
  const store = useChatStreamStore.getState();
  store.endStream(conversationId, true);
  store.hydrateFromServer(conversationId, [], 2, Date.now());

  const session = useChatStreamStore.getState().sessions[conversationId];
  expect(session.messages).toEqual([]);
  expect(session.interruptedTurnIds).toEqual([]);
});

it('removes an interrupted draft after a successful retry of the same question', () => {
  interruptTurn('turn-1', 'question');
  startTurn('turn-2', 'question');
  useChatStreamStore.getState().applyAnswer(conversationId, {
    id: 'turn-2',
    answer: 'completed answer',
    answer_version: 1,
  } as any);

  const session = useChatStreamStore.getState().sessions[conversationId];
  expect(session.messages.map(({ content }) => content)).toEqual([
    'question',
    'completed answer',
  ]);
  expect(session.interruptedTurnIds).toEqual([]);
});
