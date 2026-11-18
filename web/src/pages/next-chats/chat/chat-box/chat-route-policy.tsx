import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useChatCapabilities } from '@/hooks/use-chat-task-request';

export function ChatRoutePolicy({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { data } = useChatCapabilities();
  const labels: Record<string, string> = {
    fixed: '固定模型',
    fallback: '故障备用',
    auto: '自动选择',
  };
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        aria-label="文字与视觉模型路由策略"
        className="h-8 w-auto gap-2"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(data?.model_routes.chat.policies ?? ['fixed']).map((policy) => (
          <SelectItem key={policy} value={policy}>
            {labels[policy] ?? policy}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
