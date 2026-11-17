import { ChatTask, ChatTaskDetail, ChatTaskEvents } from '@/interfaces/database/chat-task';
import { restAPIv1 } from '@/utils/api';
import { IMessage } from '@/interfaces/database/chat';
import { registerNextServer } from '@/utils/register-server';

const ChatTaskUrl = `${restAPIv1}/chats/tasks`;
const Methods = {
  list: { url: ChatTaskUrl, method: 'get' },
  get: { url: ({ id }: { id: string }) => `${ChatTaskUrl}/${encodeURIComponent(id)}`, method: 'get' },
  cancel: { url: ({ id }: { id: string }) => `${ChatTaskUrl}/${encodeURIComponent(id)}/cancel`, method: 'post' },
  retry: { url: ({ id }: { id: string }) => `${ChatTaskUrl}/${encodeURIComponent(id)}/retry`, method: 'post' },
  events: { url: ({ id }: { id: string }) => `${ChatTaskUrl}/${encodeURIComponent(id)}/events`, method: 'get' },
  capabilities: { url: `${restAPIv1}/chats/capabilities`, method: 'get' },
  session: { url: ({ chatId, sessionId }: { chatId: string; sessionId: string }) => `${restAPIv1}/chats/${encodeURIComponent(chatId)}/sessions/${encodeURIComponent(sessionId)}`, method: 'get' },
} as const;

const chatTaskService = registerNextServer<keyof typeof Methods>(Methods);

export function isChatTaskTerminal(task: ChatTask) {
  return ['succeeded', 'partial_succeeded', 'failed', 'cancelled'].includes(task.state);
}

export async function fetchChatTask(id: string, signal?: AbortSignal): Promise<ChatTaskDetail> {
  const { data } = await chatTaskService.get({ id, signal }, true);
  if (data.code !== 0 || !data.data?.task) throw new Error(data.message || 'Task unavailable');
  return data.data;
}

export function reconcileChatTaskEvents(previous: ChatTaskEvents | undefined, incoming: ChatTaskEvents): ChatTaskEvents {
  if (previous && incoming.task.revision < previous.task.revision) return previous;
  let cursor = previous?.next_seq ?? 0;
  const events = [];
  let reset = incoming.reset;
  for (const event of incoming.events) {
    if (event.seq <= cursor) continue;
    if (event.task_id !== incoming.task.id || event.seq !== cursor + 1 || event.task_revision > incoming.task.revision) {
      reset = true;
      break;
    }
    cursor = event.seq;
    events.push(event);
  }
  if (incoming.next_seq !== cursor) reset = true;
  return {
    ...incoming,
    events: reset ? [] : events,
    next_seq: reset ? incoming.task.event_seq : cursor,
    reset,
  };
}

export async function fetchChatTaskEvents(id: string, previous?: ChatTaskEvents, signal?: AbortSignal) {
  const { data } = await chatTaskService.events({ id, params: { after_seq: previous?.next_seq ?? 0 }, signal }, true);
  if (data.code !== 0 || data.data?.task?.id !== id || !Array.isArray(data.data?.events)) {
    throw new Error(data.message || 'Task events unavailable');
  }
  return reconcileChatTaskEvents(previous, data.data);
}

export async function fetchChatTaskSession(chatId: string, sessionId: string, signal?: AbortSignal) {
  const requestedAt = Date.now();
  const { data } = await chatTaskService.session({ chatId, sessionId, signal, params: { include_reference: true, include_prompt: true } }, true);
  if (data.code !== 0) throw new Error(data.message || 'Session unavailable');
  return { messages: data.data.messages as IMessage[], revision: Number(data.data.update_time ?? 0), requestedAt };
}

export default chatTaskService;
