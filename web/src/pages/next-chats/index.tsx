import ListFilterBar from '@/components/list-filter-bar';
import { RenameDialog } from '@/components/rename-dialog';
import { Button } from '@/components/ui/button';
import { RAGFlowPagination } from '@/components/ui/ragflow-pagination';
import { Spin } from '@/components/ui/spin';
import { ListDeletionKey } from '@/constants/list-deletion';
import { useRailMotion } from '@/hooks/use-rail-motion';
import { useGoToPreviousPageOnEmpty } from '@/hooks/logic-hooks';
import { useFetchChatList } from '@/hooks/use-chat-request';
import { buildOwnersFilter } from '@/utils/list-filter-util';
import { ArrowUpRight, BookOpen, MessagesSquare, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChatCard } from './chat-card';
import { useRenameChat } from './hooks/use-rename-chat';

export default function ChatList() {
  const pageRef = useRef<HTMLElement>(null);
  useRailMotion(pageRef);
  const list = useFetchChatList();
  const {
    data,
    pagination,
    setPagination,
    searchString,
    setSearchString,
    filterValue,
    setFilterValue,
    loading,
  } = list;
  const { t } = useTranslation('common');
  const owners = [buildOwnersFilter(data?.chats ?? [], undefined, t('owner'))];
  const rename = useRenameChat();
  const navigate = useNavigate();
  const handleCreate = useCallback(() => navigate('/'), [navigate]);
  const handlePageChange = useCallback(
    (page: number, pageSize?: number) => setPagination({ page, pageSize }),
    [setPagination],
  );
  useGoToPreviousPageOnEmpty(data?.chats?.length, loading, {
    deletionKey: ListDeletionKey.ChatList,
    searchString,
    setSearchString,
    filterValue,
    setFilterValue,
  });
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('isCreate') === 'true')
      navigate('/', { replace: true });
  }, [searchParams, navigate]);
  return (
    <>
      <article ref={pageRef} className="rail-page" data-testid="chats-list">
        <div className="rail-page-inner">
          <header className="rail-page-heading">
            <div>
              <p className="rail-eyebrow">
                专业问答 <span>/</span> ASSISTANTS
              </p>
              <h1>铁路问答。</h1>
              <p>与知识，继续对话。</p>
            </div>
            <Button
              className="rail-primary gap-2"
              data-testid="create-chat"
              onClick={handleCreate}
            >
              <Plus className="size-4" />
              新建铁路问答
            </Button>
          </header>
          <ListFilterBar
            className="rail-list-tools"
            title={`我的铁路助手 · ${data?.total || 0}`}
            searchString={searchString}
            onSearchChange={list.handleInputChange}
            filters={owners}
            value={filterValue}
            onChange={list.handleFilterSubmit}
          />
          {loading && !data?.chats?.length ? (
            <div className="rail-empty">
              <Spin size="large" />
            </div>
          ) : data?.chats?.length ? (
            <div className="rail-chat-grid" data-rail-reveal>
              {data.chats.map((chat) => (
                <ChatCard
                  key={chat.id}
                  data={chat}
                  showChatRenameModal={rename.showChatRenameModal}
                />
              ))}
            </div>
          ) : (
            <div className="rail-empty" data-testid="chats-empty-create">
              <MessagesSquare className="size-9" />
              <h2>
                {searchString ||
                Object.values(filterValue).some((value) => value?.length)
                  ? '没有找到匹配的助手'
                  : '开启第一次铁路问答'}
              </h2>
              <p>安全规章 · 学习培训 · 设备分析 · 客运服务</p>
              <Button variant="outline" onClick={handleCreate}>
                <Plus className="size-4" />
                新建铁路问答
              </Button>
            </div>
          )}
          <footer className="rail-list-footer">
            <RAGFlowPagination
              current={pagination.current}
              pageSize={pagination.pageSize}
              total={pagination.total}
              onChange={handlePageChange}
            />
          </footer>
          <div className="rail-page-caption">
            <span>轨知 RailMind</span>
            <Link to="/datasets" className="inline-flex items-center gap-2">
              <BookOpen className="size-3" />
              管理知识库
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
        </div>
      </article>
      {rename.chatRenameVisible && (
        <RenameDialog
          hideModal={rename.hideChatRenameModal}
          onOk={rename.onChatRenameOk}
          initialName={rename.initialChatName}
          loading={rename.chatRenameLoading}
          title={rename.initialChatName}
        />
      )}
    </>
  );
}
