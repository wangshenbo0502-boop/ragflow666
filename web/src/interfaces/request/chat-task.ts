export interface ChatTaskListRequest {
  session_id?: string;
  state?: string;
  kind?: string;
  page: number;
  page_size: number;
}

export interface ChatTaskRetryRequest {
  stage: 'audio' | 'image';
  revision: number;
}
