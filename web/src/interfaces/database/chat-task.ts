export type ChatTaskState =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'succeeded'
  | 'partial_succeeded'
  | 'failed';

export interface ChatTask {
  id: string;
  chat_id: string;
  session_id: string;
  turn_id: string;
  kind: string;
  state: ChatTaskState;
  stage: string;
  revision: number;
  event_seq: number;
  upstream_status: string;
  created_at: number;
  updated_at: number;
  error_code?: string;
  error_message?: string;
  retry_of?: string;
  cost_unknown: boolean;
  cost_actual_micros: number;
  outputs: Record<string, unknown> & {
    answer?: Record<string, unknown> & { content: string };
  };
}

export interface ChatTaskAttempt {
  id: string;
  stage: string;
  model: string;
  state: string;
  reason: string;
  started_at: number;
  finished_at?: number;
  error_code?: string;
}

export interface ChatTaskDetail {
  task: ChatTask;
  attempts: ChatTaskAttempt[];
  can_cancel: boolean;
  can_retry: boolean;
  retry_stages: ('audio' | 'image')[];
  retry_disabled_reason: string;
  retry_stage_reasons: Partial<Record<'audio' | 'image', string>>;
}

export interface ChatTaskEvent {
  task_id: string;
  seq: number;
  task_revision: number;
  type: string;
  data: Record<string, unknown>;
}

export interface ChatTaskEvents {
  task: ChatTask;
  events: ChatTaskEvent[];
  next_seq: number;
  last_seq: number;
  reset: boolean;
}

export interface ChatCapabilities {
  image: { available: boolean; reason: string };
  voice: { available: boolean; reason: string };
  music: { available: boolean; reason: string };
  image_voice: { available: boolean; reason: string };
  model_routes: Record<
    'chat' | 'image' | 'voice' | 'music',
    {
      policies: string[];
      candidates: string[];
      permission_scope: string;
      fallback_disabled_reason: string;
      cost_known?: boolean;
      strict_cost_supported?: boolean;
      fixed_voice?: string;
    }
  >;
  attachments: {
    max_count: number;
    max_bytes: number;
    total_bytes: number;
    max_pixels: number;
  };
}
