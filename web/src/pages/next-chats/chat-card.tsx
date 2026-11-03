import { MoreButton } from '@/components/more-button';
import { IDialog } from '@/interfaces/database/chat';
import type { RailwayScene } from '@/interfaces/database/railway';
import dayjs from 'dayjs';
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
    description: '检索铁路安全规章，核对作业要求与应急处置依据。',
  },
  training: {
    label: '知识与学习',
    icon: GraduationCap,
    description: '梳理专业知识与业务要点，让学习有据可循。',
  },
  equipment: {
    label: '设备与检修',
    icon: Wrench,
    description: '结合设备现象与专业资料，辅助定位和分析故障。',
  },
  passenger: {
    label: '出行与服务',
    icon: Ticket,
    description: '查询客运规程与服务要求，解答旅客运输业务问题。',
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
      <div className="rail-assistant-top">
        <span className="rail-assistant-icon">
          <Icon className="size-5" />
        </span>
        <span className="rail-assistant-tag">
          {detail?.label || '知识问答'}
        </span>
        <ChatDropdown chat={data} showChatRenameModal={showChatRenameModal}>
          <MoreButton
            className="!opacity-100 !size-7"
            aria-label={`${data.name}的操作`}
          />
        </ChatDropdown>
      </div>
      <h2>
        <Link to={target}>{data.name}</Link>
      </h2>
      <p className="rail-assistant-description">
        {detail?.description ||
          data.description ||
          '基于知识库资料的专业问答。'}
      </p>
      <div className="rail-assistant-footer">
        <span>
          {data.update_time
            ? `${dayjs(data.update_time).format('MM.DD')} 更新`
            : '铁路知识助手'}
        </span>
        <Link to={target}>
          进入对话
          <ArrowUpRight className="size-4" />
        </Link>
      </div>
    </article>
  );
}
