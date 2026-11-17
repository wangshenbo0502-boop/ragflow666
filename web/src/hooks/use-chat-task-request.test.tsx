import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ChatTaskKeys, useRefreshChatTasks } from './use-chat-task-request';

jest.mock('@/services/chat-task-service', () => ({
  __esModule: true,
  default: {},
}));

it('replaces a pre-acceptance list request and leaves unrelated queries intact', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let releaseOldRequest!: (value: { tasks: string[] }) => void;
  let oldSignal!: AbortSignal;
  const load = jest
    .fn()
    .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      oldSignal = signal;
      return new Promise<{ tasks: string[] }>((resolve) => {
        releaseOldRequest = resolve;
      });
    })
    .mockResolvedValue({ tasks: ['accepted-task'] });
  const sessionKey = ChatTaskKeys.list({
    session_id: 'session',
    page: 1,
    page_size: 100,
  });
  const capability = { voice: { available: true } };
  client.setQueryData(ChatTaskKeys.capabilities(), capability);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(
    () => ({
      list: useQuery({ queryKey: sessionKey, queryFn: load }),
      refresh: useRefreshChatTasks(),
    }),
    { wrapper },
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  await act(async () => {
    await result.current.refresh();
  });
  await waitFor(() =>
    expect(result.current.list.data).toEqual({ tasks: ['accepted-task'] }),
  );
  expect(oldSignal.aborted).toBe(true);
  await act(async () => {
    releaseOldRequest({ tasks: [] });
  });
  expect(client.getQueryData(sessionKey)).toEqual({
    tasks: ['accepted-task'],
  });
  expect(load).toHaveBeenCalledTimes(2);
  expect(client.getQueryData(ChatTaskKeys.capabilities())).toBe(capability);
  unmount();
  client.clear();
});

it('keeps refreshing the original session after its observer unmounts', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const key = ChatTaskKeys.list({
    session_id: 'original',
    page: 1,
    page_size: 100,
  });
  client.setQueryData(key, { tasks: [] });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useRefreshChatTasks(), {
    wrapper,
  });
  const refresh = result.current;
  unmount();
  await refresh();
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  client.clear();
});
