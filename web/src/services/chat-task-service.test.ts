import { reconcileChatTaskEvents } from './chat-task-service';

type Task = import('@/interfaces/database/chat-task').ChatTask;
type Events = import('@/interfaces/database/chat-task').ChatTaskEvents;

jest.mock('@/utils/register-server', () => ({ registerNextServer: () => ({}) }));
jest.mock('@/utils/api', () => ({ restAPIv1: '/api/v1' }));

function snapshot(revision: number, seq: number): Events {
  return {
    task: { id: 'task', revision, event_seq: seq } as Task,
    events: [],
    next_seq: seq,
    last_seq: seq,
    reset: false,
  };
}

const reconcile = reconcileChatTaskEvents;

function event(seq: number) {
  return { task_id: 'task', seq, task_revision: seq, type: 'stage_changed', data: {} };
}

it('deduplicates events and advances a continuous cursor', () => {
  const previous = snapshot(2, 2);
  const incoming = { ...snapshot(4, 4), events: [event(2), event(3), event(4)] };
  expect(reconcile(previous, incoming)).toMatchObject({
    next_seq: 4, reset: false, events: [event(3), event(4)],
  });
});

it('recovers gaps and expired cursors using the authoritative snapshot', () => {
  const incoming = { ...snapshot(9, 9), events: [event(8)] };
  expect(reconcile(snapshot(2, 2), incoming)).toMatchObject({
    next_seq: 9, reset: true, events: [],
  });
  expect(reconcile(snapshot(2, 2), { ...snapshot(9, 9), reset: true }))
    .toMatchObject({ next_seq: 9, reset: true, events: [] });
});

it('rejects older snapshots and foreign task events', () => {
  const previous = snapshot(9, 9);
  expect(reconcile(previous, snapshot(2, 2))).toBe(previous);
  const incoming = { ...snapshot(10, 10), events: [{ ...event(10), task_id: 'other' }] };
  expect(reconcile(previous, incoming)).toMatchObject({
    next_seq: 10, reset: true, events: [],
  });
});
