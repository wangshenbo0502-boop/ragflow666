import {
  ChatCapabilities,
  ChatTask,
  ChatTaskEvents,
} from '@/interfaces/database/chat-task';
import {
  ChatTaskListRequest,
  ChatTaskRetryRequest,
} from '@/interfaces/request/chat-task';
import chatTaskService, {
  fetchChatTask,
  fetchChatTaskEvents,
  fetchChatTaskSession,
  isChatTaskTerminal,
} from '@/services/chat-task-service';
import {
  useMutation,
  useQuery,
  useQueries,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

export const ChatTaskKeys = {
  all: ['chatTasks'] as const,
  lists: () => [...ChatTaskKeys.all, 'list'] as const,
  list: (params: ChatTaskListRequest) =>
    [...ChatTaskKeys.lists(), params] as const,
  detail: (id: string) => [...ChatTaskKeys.all, 'detail', id] as const,
  events: (id: string) => [...ChatTaskKeys.all, 'events', id] as const,
  capabilities: () => [...ChatTaskKeys.all, 'capabilities'] as const,
  session: (chatId: string, sessionId: string) =>
    [...ChatTaskKeys.all, 'session', chatId, sessionId] as const,
};

export function useRefreshChatTasks() {
  const client = useQueryClient();
  return useCallback(async () => {
    // Discard a list request begun before acknowledgement before reloading it.
    await client.cancelQueries({ queryKey: ChatTaskKeys.lists() });
    await client.invalidateQueries({ queryKey: ChatTaskKeys.lists() });
  }, [client]);
}

export function useChatTaskEvents(tasks: ChatTask[]) {
  const client = useQueryClient();
  const revisions = useRef(new Map<string, number>());
  const results = useQueries({
    queries: tasks.map((task) => ({
      queryKey: ChatTaskKeys.events(task.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchChatTaskEvents(
          task.id,
          client.getQueryData<ChatTaskEvents>(ChatTaskKeys.events(task.id)),
          signal,
        ),
      refetchInterval: (query: { state: { data?: ChatTaskEvents } }) => {
        const data = query.state.data;
        return data &&
          isChatTaskTerminal(data.task) &&
          data.next_seq >= data.last_seq
          ? false
          : 2000;
      },
    })),
  });
  useEffect(() => {
    for (const result of results) {
      const task = result.data?.task;
      if (!task || revisions.current.get(task.id) === task.revision) continue;
      revisions.current.set(task.id, task.revision);
      void client.invalidateQueries({
        queryKey: ChatTaskKeys.session(task.chat_id, task.session_id),
      });
      void client.invalidateQueries({ queryKey: ChatTaskKeys.detail(task.id) });
    }
  }, [client, results]);
}

export function useChatTaskSession(chatId: string, sessionId: string) {
  return useQuery({
    queryKey: ChatTaskKeys.session(chatId, sessionId),
    queryFn: ({ signal }) => fetchChatTaskSession(chatId, sessionId, signal),
    enabled: Boolean(chatId && sessionId),
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });
}

export function useChatTasks(params: ChatTaskListRequest) {
  return useQuery({
    queryKey: ChatTaskKeys.list(params),
    queryFn: async ({ signal }) => {
      const { data } = await chatTaskService.list({ params, signal }, true);
      if (data.code !== 0) throw new Error(data.message);
      return data.data as { tasks: ChatTask[]; total: number };
    },
    refetchInterval: 3000,
    enabled: params.session_id !== '',
  });
}

export function useChatTask(id: string) {
  return useQuery({
    queryKey: ChatTaskKeys.detail(id),
    queryFn: ({ signal }) => fetchChatTask(id, signal),
    enabled: Boolean(id),
    refetchInterval: 2000,
  });
}

export function useChatCapabilities() {
  return useQuery({
    queryKey: ChatTaskKeys.capabilities(),
    queryFn: async ({ signal }) => {
      const { data } = await chatTaskService.capabilities({ signal }, true);
      if (data.code !== 0) throw new Error(data.message);
      return data.data as ChatCapabilities;
    },
    staleTime: 15000,
    refetchInterval: 15000,
  });
}

export function useChatTaskAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: {
      id: string;
      retry?: ChatTaskRetryRequest;
    }) => {
      const response = request.retry
        ? await chatTaskService.retry(
            { id: request.id, data: request.retry },
            true,
          )
        : await chatTaskService.cancel({ id: request.id }, true);
      if (response.data.code !== 0) throw new Error(response.data.message);
      return response.data.data as ChatTask;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ChatTaskKeys.all }),
  });
}
