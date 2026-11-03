import { MoreButton } from '@/components/more-button';
import { IDialog } from '@/interfaces/database/chat';
import type { RailwayScene } from '@/interfaces/database/railway';
import {
  ArrowUpRight,
  GraduationCap,
  MessagesSquare,
  ShieldCheck,
  Ticket,
  Wrench,
} from 'lucide-react';
import { Link } from 'react-router';
import { ChatDropdown } from './chat-dropdown';
import { useRenameChat } from './hooks/use-rename-chat';

const SceneDetails = {
  safety: {
    label: '规章与安全',
    icon: ShieldCheck,
  },
  training: {
    label: '知识与学习',
    icon: GraduationCap,
  },
  equipment: {
    label: '设备与检修',
    icon: Wrench,
  },
  passenger: {
    label: '出行与服务',
    icon: Ticket,
  },
};

function getScene(data: IDialog): RailwayScene | undefined {
  if (data.prompt_config?.railway_scene)
    return data.prompt_config.railway_scene;
  if (data.name.includes('安全')) return 'safety';
  if (data.name.includes('学习') || data.name.includes('培训'))
    return 'training';
  if (data.name.includes('设备')) return 'equipment';
  if (data.name.includes('客运')) return 'passenger';
  return undefined;
}

type ChatCardProps = { data: IDialog } & Pick<
  ReturnType<typeof useRenameChat>,
  'showChatRenameModal'
>;

export function ChatCard({ data, showChatRenameModal }: ChatCardProps) {
  const scene = getScene(data);
  const detail = scene ? SceneDetails[scene] : undefined;
  const Icon = detail?.icon || MessagesSquare;
  const target = `/chat/${data.id}`;
  return (
    <article
      className="rail-assistant group"
      data-scene={scene}
      data-agent-name={data.name}
    >
      <Link to={target} className="rail-assistant-main">
        <span className="rail-assistant-icon">
          <Icon className="size-5" />
        </span>
        <div>
          <span className="rail-assistant-tag">
            {detail?.label || '知识问答'}
          </span>
          <h2>{data.name}</h2>
        </div>
        <ArrowUpRight className="rail-assistant-arrow size-5" />
      </Link>
      <ChatDropdown chat={data} showChatRenameModal={showChatRenameModal}>
        <MoreButton
          className="!opacity-100 !size-7"
          aria-label={`${data.name}的操作`}
        />
      </ChatDropdown>
    </article>
  );
}
