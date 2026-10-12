import {
  createRailwayChat,
  importRailwaySources,
  pendingRailwayDocuments,
  RailwayDatasetName,
} from './railway-service';
import { createHash, webcrypto } from 'node:crypto';
import { registerNextServer } from '@/utils/register-server';
import chatService from './next-chat-service';

jest.mock('@/utils/register-server', () => ({
  registerNextServer: jest.fn(() => ({
    datasets: jest.fn(),
    createDataset: jest.fn(),
    documents: jest.fn(),
    upload: jest.fn(),
    parse: jest.fn(),
  })),
}));
jest.mock('./next-chat-service', () => ({
  __esModule: true,
  default: { createChat: jest.fn() },
}));

const Api = (registerNextServer as jest.Mock).mock.results[0].value;
const ok = (data: unknown) => ({ data: { code: 0, data } });
const Source = {
  id: 'safety',
  file: 'safety.md',
  title: '安全条例',
  url: 'https://www.nra.gov.cn/verified',
  sha256: createHash('sha256')
    .update(`https://www.nra.gov.cn/verified\n${'正文'.repeat(700)}`)
    .digest('hex'),
};
const Dataset = { id: 'kb-1', name: RailwayDatasetName, tenant_id: 'owner' };
const document = <Status extends string>(status: Status) => ({
  id: 'doc-1',
  name: 'safety.md',
  ingestion_status: status,
  chunk_count: status === 'COMPLETED' ? 8 : 0,
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: webcrypto,
  });
  global.fetch = jest.fn().mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      json: async () => [Source],
      arrayBuffer: async () =>
        new TextEncoder().encode(
          `${Source.url}\n${'正文'.repeat(700)}`,
        ).buffer,
      url,
    }),
  );
  Api.datasets.mockResolvedValue({
    ...ok([Dataset]),
    data: { ...ok([Dataset]).data, total_datasets: 1 },
  });
  Api.documents.mockResolvedValue(ok({ docs: [document('COMPLETED')], total: 1 }));
  Api.parse.mockResolvedValue(ok({ success_count: 1 }));
  Api.upload.mockResolvedValue(ok([]));
});

test('completed import is idempotent and never requeues completed documents', async () => {
  await expect(importRailwaySources('embed', 'owner', jest.fn())).resolves.toBe(
    'kb-1',
  );
  expect(Api.createDataset).not.toHaveBeenCalled();
  expect(Api.upload).not.toHaveBeenCalled();
  expect(Api.parse).not.toHaveBeenCalled();
});

test('failed parsing retries with Go document_ids payload', async () => {
  Api.documents.mockResolvedValue(ok({ docs: [document('FAILED')], total: 1 }));
  await importRailwaySources('embed', 'owner', jest.fn());
  expect(Api.parse).toHaveBeenCalledWith(
    {
      url: '/api/v1/datasets/kb-1/documents/parse',
      data: { document_ids: ['doc-1'] },
    },
    true,
  );
  expect(Api.upload).not.toHaveBeenCalled();
});

test('rejects a source when its content hash does not match the manifest', async () => {
  const tampered = `${Source.url}\n${'被篡改'.repeat(700)}`;
  Api.documents.mockResolvedValue(ok({ docs: [], total: 0 }));
  global.fetch = jest.fn().mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      json: async () => [Source],
      arrayBuffer: async () => new TextEncoder().encode(tampered).buffer,
      url,
    }),
  );

  await expect(
    importRailwaySources('embed', 'owner', jest.fn()),
  ).rejects.toThrow('资料完整性校验失败');
  expect(Api.upload).not.toHaveBeenCalled();
});

test('uploads verified bytes and queues the persisted document', async () => {
  Api.documents
    .mockResolvedValueOnce(ok({ docs: [], total: 0 }))
    .mockResolvedValueOnce(ok({ docs: [document('UNSTART')], total: 1 }));
  await expect(
    importRailwaySources('embed', 'owner', jest.fn()),
  ).resolves.toBe('kb-1');
  const file = Api.upload.mock.calls[0][0].data.get('file') as File;
  expect(file.name).toBe(Source.file);
  expect(file.size).toBe(
    new TextEncoder().encode(`${Source.url}\n${'正文'.repeat(700)}`).length,
  );
  expect(Api.parse).toHaveBeenCalledWith(
    {
      url: '/api/v1/datasets/kb-1/documents/parse',
      data: { document_ids: ['doc-1'] },
    },
    true,
  );
});

test('active tasks are left running on retry', () => {
  expect(
    pendingRailwayDocuments([
      document('RUNNING'),
      document('SCHEDULED'),
      document('CREATED'),
      document('STOPPING'),
      document('COMPLETED'),
      document('UNSTART'),
    ]).map((doc) => doc.ingestion_status),
  ).toEqual(['UNSTART']);
});

test('stopped tasks can be retried without reuploading the document', async () => {
  Api.documents.mockResolvedValue(ok({ docs: [document('STOPPED')], total: 1 }));
  await importRailwaySources('embed', 'owner', jest.fn());
  expect(Api.upload).not.toHaveBeenCalled();
  expect(Api.parse).toHaveBeenCalledWith(
    {
      url: '/api/v1/datasets/kb-1/documents/parse',
      data: { document_ids: ['doc-1'] },
    },
    true,
  );
});

test('another member shared dataset is not used for importing', async () => {
  Api.datasets.mockResolvedValue({
    data: {
      code: 0,
      data: [{ ...Dataset, tenant_id: 'other' }],
      total_datasets: 1,
    },
  });
  Api.createDataset.mockResolvedValue(ok(Dataset));
  await importRailwaySources('embed', 'owner', jest.fn());
  expect(Api.createDataset).toHaveBeenCalledWith(
    expect.objectContaining({
      permission: 'me',
      embedding_model: 'embed',
      parser_id: 'naive',
      parse_type: 1,
    }),
  );
});

test('partial task submission is reported as failure', async () => {
  Api.documents.mockResolvedValue(
    ok({ docs: [document('UNSTART')], total: 1 }),
  );
  Api.parse.mockResolvedValue(ok({ success_count: 0 }));
  await expect(
    importRailwaySources('embed', 'owner', jest.fn()),
  ).rejects.toThrow('部分解析任务');
});

test('creation preserves the scene and knowledge binding', async () => {
  (chatService.createChat as jest.Mock).mockResolvedValue(ok({ id: 'chat-1' }));
  await createRailwayChat('kb-1', 'chat-model', 'equipment');
  expect(chatService.createChat).toHaveBeenCalledWith(
    expect.objectContaining({
      dataset_ids: ['kb-1'],
      llm_id: 'chat-model',
      prompt_config: expect.objectContaining({
        domain: 'railway',
        railway_scene: 'equipment',
        quote: true,
      }),
    }),
  );
});
