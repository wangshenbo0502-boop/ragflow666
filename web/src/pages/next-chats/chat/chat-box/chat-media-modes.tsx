import { Button } from '@/components/ui/button';
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
import { useChatCapabilities } from '@/hooks/use-chat-task-request';
import { ImagePlus, Images, MessageSquare, Music, Volume2 } from 'lucide-react';
import { useCallback } from 'react';

export type ChatMediaMode =
  | 'chat'
  | 'image'
  | 'voice'
  | 'music'
  | 'image_voice';
const Modes = [
  { value: 'chat', label: '普通问答', icon: MessageSquare },
  { value: 'image', label: '生成图片', icon: ImagePlus },
  { value: 'voice', label: '语音回答', icon: Volume2 },
  { value: 'music', label: '生成歌曲', icon: Music },
  { value: 'image_voice', label: '图片与配音', icon: Images },
] as const;

export function ChatMediaModes({
  mode,
  onModeChange,
  disabled,
}: {
  mode: ChatMediaMode;
  onModeChange: (mode: ChatMediaMode) => void;
  disabled: boolean;
}) {
  const { data } = useChatCapabilities();
  const changeMode = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) =>
      onModeChange(event.currentTarget.dataset.mode as ChatMediaMode),
    [onModeChange],
  );
  return (
    <div className="flex flex-wrap items-center gap-1">
      {Modes.map(({ value, label, icon: Icon }) => {
        const capability =
          value === 'chat' ? { available: true, reason: '' } : data?.[value];
        return (
          <Tooltip key={value}>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant={mode === value ? 'secondary' : 'ghost'}
                  size="icon"
                  aria-label={label}
                  aria-pressed={mode === value}
                  data-mode={value}
                  onClick={changeMode}
                  disabled={disabled || !capability?.available}
                >
                  <Icon size={18} />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64 break-words">
              {capability?.reason || label}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

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
      <SelectTrigger aria-label="文字与视觉模型路由策略" className="w-32">
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
