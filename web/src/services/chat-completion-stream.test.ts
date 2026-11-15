jest.mock('@/utils/api', () => ({
  __esModule: true,
  default: { completionUrl: '/chat/completions' },
}));
jest.mock('@/utils/authorization-util', () => ({
  getAuthorization: () => 'test-auth',
}));
jest.mock('eventsource-parser/stream', () => ({
  EventSourceParserStream: jest.fn(),
}));
import { requestChatCompletionStream } from './chat-completion-stream';

it('sends a stable turn ID with attachments so the same message can be deleted', async () => {
  global.fetch = jest.fn().mockResolvedValue({});
  const files = [{ id: 'image', name: 'portrait.png' }] as any;
  await requestChatCompletionStream(
    {
      messageId: 'turn-1',
      chatId: 'chat',
      sessionId: 'session',
      question: '@生图 蓝底',
      files,
    },
    new AbortController().signal,
  );
  const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
  expect(body.messages).toEqual([
    { id: 'turn-1', role: 'user', content: '@生图 蓝底', files },
  ]);
  expect(body.question).toBeUndefined();
  expect(body.chat_id).toBe('chat');
});
