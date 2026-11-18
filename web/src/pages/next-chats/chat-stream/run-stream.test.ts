import {
  parseCompletionEventStream,
  requestChatCompletionStream,
} from '@/services/chat-completion-stream';
import { runChatCompletionStream } from './run-stream';
import { useChatStreamStore } from './store';
import { fetchChatTask } from '@/services/chat-task-service';

jest.mock('@/services/chat-task-service', () => ({
  fetchChatTask: jest.fn(),
  isChatTaskTerminal: (task: { state: string }) =>
    ['succeeded', 'partial_succeeded', 'failed', 'cancelled'].includes(
      task.state,
    ),
}));

jest.mock('@/services/chat-completion-stream', () => ({
  parseCompletionEventStream: jest.fn(),
  requestChatCompletionStream: jest.fn(),
}));

jest.mock('./store', () => ({
  useChatStreamStore: {
    getState: jest.fn(),
  },
}));

const parseStream = parseCompletionEventStream as jest.Mock;
const requestStream = requestChatCompletionStream as jest.Mock;
const getState = useChatStreamStore.getState as jest.Mock;

function response(
  body: string,
  contentType = 'text/event-stream',
  status = 200,
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  getState.mockReturnValue({
    beginStream: () => true,
    applyAnswer: jest.fn(),
    endStream: jest.fn(),
  });
});

it('only reports success after the explicit terminal event', async () => {
  requestStream.mockResolvedValue(response(''));
  parseStream.mockImplementation(async function* () {
    yield { answer: 'answer', final: true };
    yield { streamTerminal: true };
  });

  await expect(
    runChatCompletionStream({
      conversationId: 'session',
      question: 'question',
    }),
  ).resolves.toEqual({ ok: true, aborted: false, accepted: false });
  expect(getState().endStream).toHaveBeenCalledWith('session', false);
});

it('treats EOF without a terminal event as an incomplete response', async () => {
  requestStream.mockResolvedValue(response(''));
  parseStream.mockImplementation(async function* () {
    yield { answer: 'partial' };
  });

  await expect(
    runChatCompletionStream({
      conversationId: 'session',
      question: 'question',
    }),
  ).resolves.toEqual({ ok: false, aborted: false, accepted: false });
  expect(getState().endStream).toHaveBeenCalledWith('session', true);
});

it('protects explicitly stopped ordinary output without reporting a request failure', async () => {
  requestStream.mockResolvedValue(response(''));
  parseStream.mockImplementation(async function* () {
    yield { id: 'turn', answer: 'partial answer', answer_version: 1 };
    throw new DOMException('stopped', 'AbortError');
  });

  await expect(
    runChatCompletionStream({ conversationId: 'session', question: 'q' }),
  ).resolves.toEqual({ accepted: false, ok: false, aborted: true });
  expect(getState().applyAnswer).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({ answer: 'partial answer' }),
  );
  expect(getState().endStream).toHaveBeenCalledWith('session', true);
});

it('treats an SSE business error as a failed response', async () => {
  requestStream.mockResolvedValue(response(''));
  parseStream.mockImplementation(async function* () {
    yield { answer: 'partial' };
    throw new Error('upstream unavailable');
  });

  await expect(
    runChatCompletionStream({
      conversationId: 'session',
      question: 'question',
    }),
  ).resolves.toEqual({
    ok: false,
    aborted: false,
    accepted: false,
    error: 'upstream unavailable',
  });
});

it('reads a JSON error response once without starting the SSE parser', async () => {
  requestStream.mockResolvedValue(
    response(
      JSON.stringify({ code: 500, message: 'request rejected' }),
      'application/json',
      500,
    ),
  );

  await expect(
    runChatCompletionStream({
      conversationId: 'session',
      question: 'question',
    }),
  ).resolves.toEqual({
    ok: false,
    aborted: false,
    accepted: false,
    error: 'request rejected',
  });
  expect(parseStream).not.toHaveBeenCalled();
});

const taskSnapshot = (state: string, revision = 1) => ({
  id: 'durable-task',
  state,
  revision,
  outputs: {},
});

it.each(['queued', 'running'])(
  'acceptance of a %s task is not completion',
  async (state) => {
    requestStream.mockResolvedValue(response(''));
    parseStream.mockImplementation(async function* () {
      yield { task: taskSnapshot(state) };
    });
    (fetchChatTask as jest.Mock).mockResolvedValue({
      task: taskSnapshot(state),
    });
    await expect(
      runChatCompletionStream({ conversationId: 'session', question: 'q' }),
    ).resolves.toEqual({ accepted: true, ok: false, aborted: false });
    expect(fetchChatTask).toHaveBeenCalledWith('durable-task');
    expect(requestStream).toHaveBeenCalledTimes(1);
  },
);

it('calibrates an interrupted accepted task without resubmitting generation', async () => {
  requestStream.mockResolvedValue(response(''));
  const applyAnswer = jest.fn();
  const endStream = jest.fn();
  getState.mockReturnValue({ beginStream: () => true, applyAnswer, endStream });
  parseStream.mockImplementation(async function* () {
    yield { task: taskSnapshot('running') };
    yield { answer: 'saved text', reference: { chunks: ['evidence'] } };
    throw new Error('connection lost');
  });
  (fetchChatTask as jest.Mock).mockResolvedValue({
    task: taskSnapshot('succeeded', 5),
  });
  await expect(
    runChatCompletionStream({ conversationId: 'session', question: 'q' }),
  ).resolves.toEqual({ accepted: true, ok: true, aborted: false });
  expect(requestStream).toHaveBeenCalledTimes(1);
  expect(applyAnswer).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({
      answer: 'saved text',
      reference: { chunks: ['evidence'] },
    }),
  );
  expect(endStream).toHaveBeenCalledWith('session', false);
});

it.each(['failed', 'partial_succeeded', 'cancelled'])(
  'an accepted task ending %s is not successful',
  async (state) => {
    requestStream.mockResolvedValue(response(''));
    parseStream.mockImplementation(async function* () {
      yield { task: taskSnapshot('running') };
      yield { task: taskSnapshot(state, 3) };
      yield { task: taskSnapshot('running', 2) };
      yield { streamTerminal: true };
    });
    await expect(
      runChatCompletionStream({ conversationId: 'session', question: 'q' }),
    ).resolves.toEqual({ accepted: true, ok: false, aborted: false });
    expect(fetchChatTask).not.toHaveBeenCalled();
  },
);

it('aborting observation after acceptance preserves acceptance without cancelling the task', async () => {
  requestStream.mockResolvedValue(response(''));
  parseStream.mockImplementation(async function* () {
    yield { task: taskSnapshot('running') };
    throw new DOMException('stopped observing', 'AbortError');
  });
  await expect(
    runChatCompletionStream({ conversationId: 'session', question: 'q' }),
  ).resolves.toEqual({ accepted: true, ok: false, aborted: true });
  expect(fetchChatTask).not.toHaveBeenCalled();
  expect(requestStream).toHaveBeenCalledTimes(1);
});

it('uses an authoritative terminal snapshot even if the final SSE marker is lost', async () => {
  requestStream.mockResolvedValue(response(''));
  parseStream.mockImplementation(async function* () {
    yield { task: taskSnapshot('succeeded', 5) };
  });
  await expect(
    runChatCompletionStream({ conversationId: 'session', question: 'q' }),
  ).resolves.toEqual({ accepted: true, ok: true, aborted: false });
});

it('publishes acknowledged state immediately and ignores duplicate or older revisions', async () => {
  requestStream.mockResolvedValue(response(''));
  const onTaskUpdate = jest.fn();
  parseStream.mockImplementation(async function* () {
    yield { task: taskSnapshot('queued') };
    expect(onTaskUpdate).toHaveBeenCalledWith(taskSnapshot('queued'));
    yield { task: taskSnapshot('running', 2) };
    yield { task: taskSnapshot('queued') };
    yield { task: taskSnapshot('running', 2) };
    yield { task: taskSnapshot('succeeded', 3) };
    yield { task: taskSnapshot('running', 2) };
    yield { streamTerminal: true };
  });
  await expect(
    runChatCompletionStream({
      conversationId: 'session',
      question: 'q',
      onTaskUpdate,
    }),
  ).resolves.toEqual({ accepted: true, ok: true, aborted: false });
  expect(onTaskUpdate.mock.calls.map(([task]) => task)).toEqual([
    taskSnapshot('queued'),
    taskSnapshot('running', 2),
    taskSnapshot('succeeded', 3),
  ]);
});

it('publishes the calibrated state after an accepted stream disconnects', async () => {
  requestStream.mockResolvedValue(response(''));
  const onTaskUpdate = jest.fn();
  parseStream.mockImplementation(async function* () {
    yield { task: taskSnapshot('running', 2) };
    throw new Error('connection lost');
  });
  (fetchChatTask as jest.Mock).mockResolvedValue({
    task: taskSnapshot('failed', 4),
  });
  await expect(
    runChatCompletionStream({
      conversationId: 'session',
      question: 'q',
      onTaskUpdate,
    }),
  ).resolves.toEqual({ accepted: true, ok: false, aborted: false });
  expect(onTaskUpdate.mock.calls.map(([task]) => task)).toEqual([
    taskSnapshot('running', 2),
    taskSnapshot('failed', 4),
  ]);
});

it('does not publish a stale calibration snapshot after a newer streamed revision', async () => {
  requestStream.mockResolvedValue(response(''));
  const onTaskUpdate = jest.fn();
  parseStream.mockImplementation(async function* () {
    yield { task: taskSnapshot('running', 4) };
  });
  (fetchChatTask as jest.Mock).mockResolvedValue({
    task: taskSnapshot('queued', 2),
  });
  await expect(
    runChatCompletionStream({
      conversationId: 'session',
      question: 'q',
      onTaskUpdate,
    }),
  ).resolves.toEqual({ accepted: true, ok: false, aborted: false });
  expect(onTaskUpdate).toHaveBeenCalledTimes(1);
  expect(onTaskUpdate).toHaveBeenCalledWith(taskSnapshot('running', 4));
});
