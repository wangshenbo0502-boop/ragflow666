export const ChatTaskStates = {
  queued: '排队中',
  running: '执行中',
  cancel_requested: '正在取消',
  cancelled: '已取消',
  succeeded: '已完成',
  partial_succeeded: '部分完成',
  failed: '失败',
};

export const ChatTaskKinds: Record<string, string> = {
  生图: '生成图片',
  语音: '语音回答',
  'qwen3-tts': '语音回答',
  image_voice: '图片与配音',
};

export const ChatTaskStages: Record<string, string> = {
  accepted: '等待执行',
  planning: '正在规划',
  language: '正在生成文字',
  image: '正在生成图片',
  audio: '正在合成语音',
  music: '正在生成歌曲',
  image_queued: '图片等待资源',
  audio_queued: '语音等待资源',
  music_queued: '歌曲等待资源',
  language_queued: '文字等待资源',
};

export const ChatTaskRetryReasons: Record<string, string> = {
  revision_conflict: '回答已更新，不能重试旧版本',
  upstream_result_unknown: '上游结果尚未确认',
  task_not_retryable: '当前任务状态不允许重试',
  checkpoint_incomplete: '缺少完整的恢复检查点',
  forbidden: '当前没有执行权限',
  no_retryable_stage: '没有可重试的阶段',
};
