import { LLMFactory } from '@/constants/llm';

export const ProviderOptions = [
  { name: LLMFactory.DeepSeek, label: 'DeepSeek' },
  { name: LLMFactory.ZhipuAI, label: 'GLM / 智谱' },
  {
    name: LLMFactory.OpenAiAPICompatible,
    label: '自定义 / OpenAI 兼容',
  },
  { name: LLMFactory.XunFeiSpark, label: '讯飞 / Spark' },
  { name: LLMFactory.TongYiQianWen, label: '阿里云 / 通义千问' },
  { name: LLMFactory.Xiaomi, label: '小米 / MiMo' },
] as const;
