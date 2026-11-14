import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import Home from '../home';
import { useRailwayWorkbench } from '../home/use-railway-workbench';
import ChatList from './index';

jest.mock('@/hooks/use-rail-motion', () => ({
  useRailMotion: jest.fn(),
}));
jest.mock('@/hooks/logic-hooks', () => ({
  useGoToPreviousPageOnEmpty: jest.fn(),
}));
jest.mock('@/hooks/use-chat-request', () => ({
  useFetchChatList: () => ({
    data: { chats: [], total: 0 },
    pagination: { current: 1, pageSize: 10, total: 0 },
    filterValue: {},
    searchString: '',
    loading: false,
  }),
}));
jest.mock('@/utils/list-filter-util', () => ({
  buildOwnersFilter: jest.fn(),
}));
jest.mock('@/components/list-filter-bar', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/ui/ragflow-pagination', () => ({
  RAGFlowPagination: () => null,
}));
jest.mock('@/components/rename-dialog', () => ({
  RenameDialog: () => null,
}));
jest.mock('./hooks/use-rename-chat', () => ({
  useRenameChat: () => ({}),
}));
jest.mock('./chat-card', () => ({ ChatCard: () => null }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('../home/use-railway-workbench', () => ({
  useRailwayWorkbench: jest.fn(),
}));
jest.mock('@/components/rail-scroll-heading', () => ({
  RailScrollHeading: () => null,
}));
jest.mock('@/components/rail-scroll-diagram', () => ({
  RailScrollDiagram: () => null,
}));
jest.mock('../home/equipment-intake', () => ({
  EquipmentIntake: () => null,
}));

const MockWorkbench = jest.mocked(useRailwayWorkbench);
const MockStart = jest.fn();
const MockScroll = jest.fn();

function Back() {
  const navigate = useNavigate();
  function handleBack() {
    navigate(-1);
  }
  return <button onClick={handleBack}>返回</button>;
}

function setup(entries = ['/chats']) {
  return render(
    <MemoryRouter initialEntries={entries}>
      <Back />
      <Routes>
        <Route path="/chats" element={<ChatList />} />
        <Route path="/home" element={<Home />} />
        <Route path="/datasets" element={<p>知识库列表</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  Element.prototype.scrollIntoView = MockScroll;
  MockWorkbench.mockReturnValue({
    scene: 'safety',
    question: '',
    selectedId: 'kb-1',
    canStart: true,
    readyDocumentCount: 1,
    models: { llm_id: 'model-1', embd_id: 'embedding-1' },
    datasets: { data: [{ id: 'kb-1', name: '铁路资料' }] },
    documents: { data: [{ id: 'doc-1', ingestion_status: 'COMPLETED' }] },
    sources: { data: [] },
    initialize: {},
    start: { mutate: MockStart, isPending: false },
  } as unknown as ReturnType<typeof MockWorkbench>);
});

test.each([0, 1])(
  'creation entry %s opens and focuses the shared workbench',
  async (entry) => {
    setup();
    fireEvent.click(
      screen.getAllByRole('link', { name: '新建铁路问答' })[entry],
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '铁路问题' })).toHaveFocus(),
    );
    expect(MockScroll).toHaveBeenCalled();
    expect(MockStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.getByTestId('chats-list')).toBeInTheDocument();
  },
);

test('the query creation entry replaces history without a redirect loop on back', async () => {
  setup(['/datasets', '/chats?isCreate=true']);
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: '铁路问题' })).toHaveFocus(),
  );
  expect(MockStart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  expect(screen.getByText('知识库列表')).toBeInTheDocument();
});

test('double clicking creates once and a settled request can be retried', () => {
  setup(['/home']);
  const start = screen.getByRole('button', { name: '开始铁路对话' });
  fireEvent.click(start);
  fireEvent.click(start);
  expect(MockStart).toHaveBeenCalledTimes(1);
  MockStart.mock.calls[0][1].onSettled();
  fireEvent.click(start);
  expect(MockStart).toHaveBeenCalledTimes(2);
});

test('an unready workbench cannot create through the keyboard shortcut', () => {
  MockWorkbench.mockReturnValue({
    ...MockWorkbench(),
    canStart: false,
  });
  setup(['/home']);
  expect(screen.getByRole('button', { name: '开始铁路对话' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('textbox', { name: '铁路问题' }), {
    key: 'Enter',
    ctrlKey: true,
  });
  expect(MockStart).not.toHaveBeenCalled();
});
