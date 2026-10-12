import type { IngestionTaskStatus } from '@/constants/knowledge';

export interface RailwaySource {
  id: string;
  title: string;
  category: string;
  url: string;
  publisher: string;
  collectedAt: string;
  characters: number;
  sha256: string;
  file: string;
  versionStatus: string;
}

export interface RailwayDataset {
  id: string;
  name: string;
  tenant_id: string;
  chunk_count: number;
}

export interface RailwayDocument {
  id: string;
  name: string;
  ingestion_status: `${IngestionTaskStatus}`;
  chunk_count: number;
  progress_msg?: string;
}

export type RailwayScene = 'safety' | 'passenger' | 'equipment' | 'training';
