import { useChatTasks, useChatTaskSession, useChatTaskEvents } from '@/hooks/use-chat-task-request';
import { isChatTaskTerminal } from '@/services/chat-task-service';
import { buildMessageListWithUuid } from '@/utils/chat';
import { useEffect } from 'react';
import { useChatStreamStore } from '../chat-stream/store';

export function useChatTaskRecovery(chatId: string, sessionId: string) {
  const snapshot = useChatTaskSession(chatId, sessionId);
  const tasks = useChatTasks({ session_id: sessionId, page: 1, page_size: 100 });
  useChatTaskEvents(tasks.data?.tasks ?? []);
  const hydrate = useChatStreamStore((state) => state.hydrateFromServer);
  useEffect(() => {
    if (!snapshot.data || !sessionId) return;
    hydrate(sessionId, buildMessageListWithUuid(snapshot.data.messages), snapshot.data.revision, snapshot.data.requestedAt);
  }, [hydrate, sessionId, snapshot.data]);
  return {
    tasks: tasks.data?.tasks ?? [],
    active: tasks.data?.tasks.filter((task) => !isChatTaskTerminal(task)) ?? [],
    error: snapshot.error ?? tasks.error,
  };
}
