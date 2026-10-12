import type {
  RailwayDataset,
  RailwayDocument,
  RailwayScene,
  RailwaySource,
} from '@/interfaces/database/railway';
import { IngestionTaskStatus } from '@/constants/knowledge';
import { registerNextServer } from '@/utils/register-server';
import chatService from './next-chat-service';

export const RailwayDatasetName = '轨知 · 铁路公开规章';
const RailwayApi = registerNextServer({
  datasets: { url: '/api/v1/datasets', method: 'get' },
  createDataset: { url: '/api/v1/datasets', method: 'post' },
  documents: { url: '/api/v1/datasets', method: 'get' },
  upload: { url: '/api/v1/datasets', method: 'post' },
  parse: { url: '/api/v1/datasets', method: 'post' },
});

function unwrap<T>(response: {
  data: { code: number; data: T; message?: string };
}): T {
  if (response.data.code !== 0) {
    throw new Error(
      response.data.message || '请求失败，请检查服务连接和模型配置',
    );
  }
  return response.data.data;
}

async function asset(file: string) {
  const response = await fetch(`${import.meta.env.BASE_URL}railway/${file}`);
  if (!response.ok) throw new Error(`资料读取失败：${file}`);
  return response;
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前环境不支持资料完整性校验');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function listRailwaySources(): Promise<RailwaySource[]> {
  return (await asset('manifest.json')).json();
}

export async function listRailwayDatasets(): Promise<RailwayDataset[]> {
  const result: RailwayDataset[] = [];
  for (let page = 1; ; page++) {
    const response = await RailwayApi.datasets(
      { params: { page, page_size: 100 } },
      true,
    );
    const items = unwrap<RailwayDataset[]>(response);
    result.push(...items);
    if (!items.length || result.length >= response.data.total_datasets)
      return result;
  }
}

export async function listRailwayDocuments(
  datasetId: string,
): Promise<RailwayDocument[]> {
  const result: RailwayDocument[] = [];
  for (let page = 1; ; page++) {
    const data = unwrap<{ docs: RailwayDocument[]; total: number }>(
      await RailwayApi.documents(
        {
          url: `/api/v1/datasets/${datasetId}/documents`,
          params: { page, page_size: 100 },
        },
        true,
      ),
    );
    result.push(...data.docs);
    if (!data.docs.length || result.length >= data.total) return result;
  }
}

export function pendingRailwayDocuments(documents: RailwayDocument[]) {
  return documents.filter((doc) =>
    [
      IngestionTaskStatus.UNSTART,
      IngestionTaskStatus.FAILED,
      IngestionTaskStatus.STOPPED,
    ].some((status) => status === doc.ingestion_status),
  );
}

export async function importRailwaySources(
  embeddingModel: string,
  ownerId: string,
  onProgress: (message: string) => void,
): Promise<string> {
  if (!embeddingModel || !ownerId)
    throw new Error('请先登录并配置默认嵌入模型');
  const sources = await listRailwaySources();
  if (!sources.length) throw new Error('官方资料清单为空');
  onProgress('正在准备个人铁路知识库…');
  const datasets = await listRailwayDatasets();
  // Never write to another member's similarly named shared dataset.
  let dataset = datasets.find(
    (item) => item.name === RailwayDatasetName && item.tenant_id === ownerId,
  );
  if (!dataset) {
    dataset = unwrap<RailwayDataset>(
      await RailwayApi.createDataset({
        name: RailwayDatasetName,
        embedding_model: embeddingModel,
        permission: 'me',
        language: 'Chinese',
        parser_id: 'naive',
        parse_type: 1,
        parser_config: { chunk_token_num: 512 },
      }),
    );
  }
  let documents = await listRailwayDocuments(dataset.id);
  for (const source of sources) {
    if (documents.some((doc) => doc.name === source.file)) continue;
    onProgress(`正在上传：${source.title}`);
    const response = await asset(source.file);
    const buffer = await response.arrayBuffer();
    const content = new TextDecoder().decode(buffer);
    if (!content.includes(source.url) || content.length < 1000) {
      throw new Error(`资料来源校验失败：${source.title}`);
    }
    if ((await sha256(buffer)).toLowerCase() !== source.sha256.toLowerCase()) {
      throw new Error(`资料完整性校验失败：${source.title}`);
    }
    const form = new FormData();
    form.append(
      'file',
      new File([buffer], source.file, { type: 'text/markdown' }),
    );
    unwrap(
      await RailwayApi.upload(
        {
          url: `/api/v1/datasets/${dataset.id}/documents`,
          data: form,
        },
        true,
      ),
    );
    // Read persisted state on retries, including partially successful uploads.
    documents = await listRailwayDocuments(dataset.id);
  }
  const names = new Set(sources.map((source) => source.file));
  const pending = pendingRailwayDocuments(
    documents.filter((doc) => names.has(doc.name)),
  );
  if (pending.length) {
    const result = unwrap<{ success_count: number }>(
      await RailwayApi.parse(
        {
          url: `/api/v1/datasets/${dataset.id}/documents/parse`,
          data: { document_ids: pending.map((doc) => doc.id) },
        },
        true,
      ),
    );
    if (result.success_count !== pending.length) {
      throw new Error('部分解析任务未提交成功，请重试并查看知识库日志');
    }
  }
  onProgress('资料已上传，解析状态见下方；解析完成后才能用于问答。');
  return dataset.id;
}

export async function createRailwayChat(
  datasetId: string,
  model: string,
  scene: RailwayScene,
) {
  if (!datasetId || !model)
    throw new Error('请选择已解析的知识库并配置默认对话模型');
  const names = {
    safety: '安全规章',
    passenger: '客运服务',
    equipment: '设备分析',
    training: '学习培训',
  };
  return unwrap<{ id: string }>(
    await chatService.createChat({
      name: `轨知 · ${names[scene]}`,
      language: 'Chinese',
      dataset_ids: [datasetId],
      llm_id: model,
      llm_setting: { temperature: 0.2 },
      prompt_config: {
        domain: 'railway',
        railway_scene: scene,
        system: '依据检索资料回答铁路问题：{knowledge}',
        prologue:
          '你好，我是轨知。请描述你的铁路问题；我会结合资料给出依据，并说明需要核实的信息。',
        quote: true,
        refine_multiturn: true,
        reasoning: false,
        empty_response:
          '当前资料不足以支持可靠回答，请补充适用规程和问题背景。',
        parameters: [{ key: 'knowledge', optional: false }],
      },
      similarity_threshold: 0.2,
      vector_similarity_weight: 0.3,
      top_n: 8,
    }),
  );
}
