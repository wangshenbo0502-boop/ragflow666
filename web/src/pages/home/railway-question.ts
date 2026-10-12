import type { RailwayScene } from '@/interfaces/database/railway';

export interface EquipmentContext {
  model: string;
  alarm: string;
  location: string;
  occurredAt: string;
}

export const EmptyEquipmentContext: EquipmentContext = {
  model: '',
  alarm: '',
  location: '',
  occurredAt: '',
};

export function buildRailwayQuestion(
  scene: RailwayScene,
  question: string,
  equipment: EquipmentContext,
): string {
  if (scene !== 'equipment') return question.trim();
  const details = [
    ['设备型号', equipment.model],
    ['报警代码或提示', equipment.alarm],
    ['发生位置', equipment.location],
    ['发生时间（用户当地时间）', equipment.occurredAt.replace('T', ' ')],
  ]
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}：${value.trim()}`);
  if (!details.length) return question.trim();
  return [
    question.trim(),
    '用户提供的设备现象背景（原因尚未确认）：',
    ...details,
    '请结合适用资料分析；区分已有事实与待验证假设，并说明仍需确认的信息。',
  ]
    .filter(Boolean)
    .join('\n');
}
