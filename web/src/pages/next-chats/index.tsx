import ListFilterBar from '@/components/list-filter-bar';
import { RailListState } from '@/components/rail-list-state';
import { RailPageHeading } from '@/components/rail-page-heading';
import { PrivilegeManagementDialog } from '@/ee/components/privilege-management/privilege-management-dialog';
import { useShowPrivilegeDialog } from '@/ee/pages/next-chats/use-show-privilege-dialog';
import { RenameDialog } from '@/components/rename-dialog';
import { Button } from '@/components/ui/button';
import { RAGFlowPagination } from '@/components/ui/ragflow-pagination';
import { ListDeletionKey } from '@/constants/list-deletion';
import { useGoToPreviousPageOnEmpty } from '@/hooks/logic-hooks';
import { useFetchChatList } from '@/hooks/use-chat-request';
import { buildOwnersFilter } from '@/utils/list-filter-util';
import { ArrowUpRight, BookOpen, MessagesSquare, Plus } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useSearchParams } from 'react-router';
import { ChatCard } from './chat-card';
import { useRenameChat } from './hooks/use-rename-chat';

export default function ChatList() {
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
  const privilege = useShowPrivilegeDialog();
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
  if (searchParams.get('isCreate') === 'true') {
    return <Navigate to="/home#rail-workspace" replace />;
  }
  return (
    <>
      <article className="rail-page" data-testid="chats-list">
        <div className="rail-page-inner">
          <RailPageHeading
            label="专业问答 / ASSISTANTS"
            title="铁路问答"
            description="查看铁路助手与已有会话。"
          >
            <Button
              className="rail-primary gap-2"
              data-testid="create-chat"
              asLink
              to="/home#rail-workspace"
            >
              <Plus className="size-4" />
              新建铁路问答
            </Button>
          </RailPageHeading>
          <ListFilterBar
            className="rail-list-tools"
            title={`我的铁路助手 · ${data?.total || 0}`}
            searchString={searchString}
            onSearchChange={list.handleInputChange}
            filters={owners}
            value={filterValue}
            onChange={list.handleFilterSubmit}
          />
          {list.isError ? (
            <RailListState
              error
              label="无法读取铁路助手"
              detail="请检查服务连接与账号权限。"
              onRetry={list.refetch}
            />
          ) : loading && !data?.chats?.length ? (
            <RailListState loading label="正在读取铁路助手" />
          ) : data?.chats?.length ? (
            <div className="rail-chat-grid">
              {data.chats.map((chat) => (
                <ChatCard
                  key={chat.id}
                  data={chat}
                  showChatRenameModal={rename.showChatRenameModal}
                  showPrivilegeModal={privilege.handleShowPrivilegeModal(chat)}
                />
              ))}
            </div>
          ) : (
            <RailListState
              testId="chats-empty-create"
              icon={MessagesSquare}
              label={
                searchString ||
                Object.values(filterValue).some((value) => value?.length)
                  ? '没有找到匹配的助手'
                  : '开启第一次铁路问答'
              }
            >
              <Button variant="outline" asLink to="/home#rail-workspace">
                <Plus className="size-4" />
                新建铁路问答
              </Button>
            </RailListState>
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
      {privilege.privilegeModalVisible && (
        <PrivilegeManagementDialog
          hideModal={privilege.hidePrivilegeModal}
          initialValues={privilege.privilegeRecord}
        />
      )}
    </>
  );
}
