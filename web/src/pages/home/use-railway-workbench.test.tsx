import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { IngestionTaskStatus } from '@/constants/knowledge';
import {
  createRailwayChat,
  importRailwaySources,
  listRailwayDatasets,
  listRailwayDocuments,
} from '@/services/railway-service';
import { useRailwayWorkbench } from './use-railway-workbench';

const MockNavigate = jest.fn();
jest.mock('react-router', () => ({
  useNavigate: () => MockNavigate,
}));
jest.mock('@/hooks/use-llm-request', () => ({
  useFetchDefaultModelDictionary: () => ({
    llm_id: 'chat-model',
    embd_id: 'embedding-model',
  }),
}));
jest.mock('@/hooks/use-user-setting-request', () => ({
  useFetchUserInfo: () => ({ data: { id: 'owner' } }),
}));
jest.mock('@/services/railway-service', () => ({
  RailwayDatasetName: '轨知 · 铁路公开规章',
  listRailwaySources: jest.fn().mockResolvedValue([]),
  listRailwayDatasets: jest.fn(),
  listRailwayDocuments: jest.fn(),
  importRailwaySources: jest.fn(),
  createRailwayChat: jest.fn(),
}));

const MockDatasets = jest.mocked(listRailwayDatasets);
const MockDocuments = jest.mocked(listRailwayDocuments);
const MockImport = jest.mocked(importRailwaySources);
const MockCreate = jest.mocked(createRailwayChat);
let client = new QueryClient();

const Dataset = {
  id: 'kb-railway',
  name: '轨知 · 铁路公开规章',
  tenant_id: 'owner',
  chunk_count: 12,
};

function setup() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children?: any }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return renderHook(useRailwayWorkbench, { wrapper: Wrapper });
}

beforeEach(() => {
  jest.clearAllMocks();
  MockDatasets.mockResolvedValue([Dataset]);
  MockDocuments.mockResolvedValue([
    {
      id: 'doc-1',
      name: 'railway-safety.md',
      ingestion_status: IngestionTaskStatus.COMPLETED,
      chunk_count: 12,
    },
  ]);
  MockCreate.mockResolvedValue({ id: 'chat-1' });
});

afterEach(() => client.clear());

test('starts only after Go reports completed documents with indexed chunks', async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.canStart).toBe(true));
  expect(result.current.readyDocumentCount).toBe(1);
});

test.each([
  IngestionTaskStatus.RUNNING,
  IngestionTaskStatus.FAILED,
  IngestionTaskStatus.SCHEDULED,
])(
  'does not start from stale dataset counts while document status is %s',
  async (status) => {
    MockDocuments.mockResolvedValue([
      {
        id: 'doc-1',
        name: 'railway-safety.md',
        ingestion_status: status,
        chunk_count: 12,
      },
    ]);
    const { result } = setup();
    await waitFor(() => expect(result.current.documents.isSuccess).toBe(true));
    expect(result.current.canStart).toBe(false);
  },
);

test('retains an unparsed personal railway dataset after a page refresh', async () => {
  MockDatasets.mockResolvedValue([
    { ...Dataset, id: 'other-kb', name: '其他资料' },
    { ...Dataset, chunk_count: 0 },
  ]);
  MockDocuments.mockResolvedValue([]);
  const { result } = setup();
  await waitFor(() =>
    expect(result.current.selectedId).toBe('kb-railway'),
  );
  expect(result.current.canStart).toBe(false);
  expect(MockDocuments).toHaveBeenCalledWith('kb-railway');
});

test('retains the imported ID while the dataset list is being refreshed', async () => {
  MockImport.mockResolvedValue('kb-new');
  const { result } = setup();
  await waitFor(() => expect(result.current.datasets.isSuccess).toBe(true));
  await act(async () => {
    await result.current.initialize.mutateAsync();
  });
  await waitFor(() => expect(result.current.selectedId).toBe('kb-new'));
  expect(MockDocuments).toHaveBeenCalledWith('kb-new');
  expect(result.current.canStart).toBe(false);
});

test('passes the equipment record and question into the new railway conversation', async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.canStart).toBe(true));
  act(() => {
    result.current.setScene('equipment');
    result.current.setQuestion('设备报警');
    result.current.setEquipment({
      model: '示例型号',
      alarm: 'E01',
      location: '',
      occurredAt: '',
    });
  });
  await act(async () => {
    await result.current.start.mutateAsync();
  });
  expect(MockCreate).toHaveBeenCalledWith('kb-railway', 'chat-model', 'equipment');
  expect(MockNavigate).toHaveBeenCalledWith('/chat/chat-1', {
    state: {
      railwayQuestion: expect.stringContaining('报警代码或提示：E01'),
    },
  });
});
