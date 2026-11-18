import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ChatSearchParams } from '@/constants/chat';
import {
  useChatTask,
  useChatTaskAction,
  useChatTasks,
} from '@/hooks/use-chat-task-request';
import { ChatTask } from '@/interfaces/database/chat-task';
import dayjs from 'dayjs';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  ListTodo,
  RotateCw,
  Square,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ChatTaskKinds,
  ChatTaskRetryReasons,
  ChatTaskStages,
  ChatTaskStates,
} from '../../constant/chat-tasks';

function TaskDetail({ id, onJump }: { id: string; onJump: () => void }) {
  const { data, error } = useChatTask(id);
  const action = useChatTaskAction();
  const navigate = useNavigate();
  const task = data?.task;
  const handleCancel = useCallback(() => action.mutate({ id }), [action, id]);
  const handleRetry = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!task) return;
      action.mutate({
        id,
        retry: {
          stage: event.currentTarget.dataset.stage as 'audio' | 'image',
          revision: task.revision,
        },
      });
    },
    [task, action, id],
  );
  const handleJump = useCallback(() => {
    if (!task) return;
    const params = new URLSearchParams({
      [ChatSearchParams.ConversationId]: task.session_id,
      turn: task.turn_id,
    });
    onJump();
    navigate(`/chat/${encodeURIComponent(task.chat_id)}?${params}`);
  }, [navigate, onJump, task]);
  if (error)
    return (
      <p role="alert" className="break-words">
        {error.message}
      </p>
    );
  if (!task || !data) return <p>正在读取任务…</p>;
  return (
    <div className="min-w-0 space-y-3 border-t border-border-button pt-3">
      <p className="break-all text-xs text-text-secondary">{task.id}</p>
      <p className="break-words">
        {ChatTaskStates[task.state]} ·{' '}
        {ChatTaskStages[task.stage] ?? task.stage}
      </p>
      {task.error_message && (
        <p role="alert" className="break-words">
          {task.error_message}
        </p>
      )}
      {task.upstream_status === 'unknown' && (
        <p className="break-words">
          上游是否停止尚未确认，资源仍被保留，暂不能重新生成。
        </p>
      )}
      {!data.can_retry && data.retry_disabled_reason && (
        <p className="break-words text-sm text-text-secondary">
          暂不能重试：
          {ChatTaskRetryReasons[data.retry_disabled_reason] ?? '请刷新任务状态'}
        </p>
      )}
      <p className="text-sm">
        {task.cost_unknown
          ? '费用未知'
          : `费用：${task.cost_actual_micros / 1000000}`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={handleJump}>
          <ExternalLink size={16} />
          原对话
        </Button>
        {data.can_cancel && (
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={action.isPending}
          >
            <Square size={16} />
            取消任务
          </Button>
        )}
        {data.retry_stages.map((stage) => (
          <Button
            key={stage}
            variant="outline"
            data-stage={stage}
            onClick={handleRetry}
            disabled={action.isPending}
          >
            <RotateCw size={16} />
            {stage === 'image' ? '重试图片' : '重试音频'}
          </Button>
        ))}
      </div>
      {action.error && (
        <p role="alert" className="break-words">
          {action.error.message}
        </p>
      )}
      <ol className="divide-y divide-border-button">
        {data.attempts.map((attempt) => (
          <li key={attempt.id} className="space-y-1 py-2 text-sm">
            <p className="break-words">
              {ChatTaskStages[attempt.stage] ?? attempt.stage} · {attempt.state}
            </p>
            <p className="break-all text-text-secondary">{attempt.model}</p>
            <p>
              {dayjs(attempt.started_at).format('MM-DD HH:mm:ss')}
              {attempt.finished_at
                ? ` · ${Math.max(0, attempt.finished_at - attempt.started_at)} ms`
                : ''}
            </p>
            {attempt.reason && <p className="break-words">{attempt.reason}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function TaskList({ onJump }: { onJump: () => void }) {
  const [state, setState] = useState('all');
  const [kind, setKind] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState('');
  const { data, error, isPending } = useChatTasks({
    state: state === 'all' ? undefined : state,
    kind: kind === 'all' ? undefined : kind,
    page,
    page_size: 10,
  });
  const changeState = useCallback((value: string) => {
    setState(value);
    setPage(1);
  }, []);
  const changeKind = useCallback((value: string) => {
    setKind(value);
    setPage(1);
  }, []);
  const previousPage = useCallback(
    () => setPage((value) => Math.max(1, value - 1)),
    [],
  );
  const nextPage = useCallback(() => setPage((value) => value + 1), []);
  const selectTask = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) =>
      setSelected(event.currentTarget.dataset.taskId ?? ''),
    [],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Select value={state} onValueChange={changeState}>
          <SelectTrigger aria-label="任务状态">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {Object.entries(ChatTaskStates).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={changeKind}>
          <SelectTrigger aria-label="任务类型">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            {Object.entries(ChatTaskKinds).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isPending && <p>正在读取任务…</p>}
        {error && (
          <p role="alert" className="break-words">
            {error.message}
          </p>
        )}
        {data?.tasks.length === 0 && (
          <p className="text-text-secondary">暂无任务</p>
        )}
        <ul className="divide-y divide-border-button">
          {data?.tasks.map((task: ChatTask) => (
            <li key={task.id} className="min-w-0 py-2">
              <Button
                variant="ghost"
                className="h-auto w-full min-w-0 justify-start text-left"
                data-task-id={task.id}
                onClick={selectTask}
              >
                <span className="min-w-0 space-y-1">
                  <span className="block truncate">
                    {ChatTaskKinds[task.kind] ?? task.kind} ·{' '}
                    {ChatTaskStates[task.state]}
                  </span>
                  <span className="block truncate text-xs text-text-secondary">
                    {dayjs(task.created_at).format('MM-DD HH:mm')} ·{' '}
                    {ChatTaskStages[task.stage] ?? task.stage}
                  </span>
                </span>
              </Button>
              {selected === task.id && (
                <TaskDetail id={task.id} onJump={onJump} />
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          aria-label="上一页"
          disabled={page <= 1}
          onClick={previousPage}
        >
          <ArrowLeft size={16} />
        </Button>
        <span className="text-sm">
          {page} / {Math.max(1, Math.ceil((data?.total ?? 0) / 10))}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="下一页"
          disabled={page * 10 >= (data?.total ?? 0)}
          onClick={nextPage}
        >
          <ArrowRight size={16} />
        </Button>
      </div>
    </div>
  );
}

export function ChatTaskCenter() {
  const [open, setOpen] = useState(false);
  const closeAfterJump = useCallback(() => setOpen(false), []);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="任务中心">
              <ListTodo size={18} />
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>任务中心</TooltipContent>
      </Tooltip>
      <SheetContent
        aria-describedby={undefined}
        className="flex w-[min(100%,35rem)] flex-col gap-4 rounded-none p-5 motion-reduce:animate-none"
      >
        <SheetTitle className="pr-8">任务中心</SheetTitle>
        {open && <TaskList onJump={closeAfterJump} />}
      </SheetContent>
    </Sheet>
  );
}
