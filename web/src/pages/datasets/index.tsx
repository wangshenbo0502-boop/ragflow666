import ListFilterBar from '@/components/list-filter-bar';
import { RailListState } from '@/components/rail-list-state';
import { RailPageHeading } from '@/components/rail-page-heading';
import DuplicateDialog from '@/ee/components/duplicate-dialog';
import { PrivilegeManagementDialog } from '@/ee/components/privilege-management/privilege-management-dialog';
import useDuplicateDataset from '@/ee/pages/datasets/use-duplicate-dataset';
import { useShowPrivilegeDialog } from '@/ee/pages/datasets/use-show-privilege-dialog';
import { RenameDialog } from '@/components/rename-dialog';
import { Button } from '@/components/ui/button';
import { RAGFlowPagination } from '@/components/ui/ragflow-pagination';
import { ListDeletionKey } from '@/constants/list-deletion';
import { useGoToPreviousPageOnEmpty } from '@/hooks/logic-hooks';
import { useFetchNextKnowledgeListByPage } from '@/hooks/use-knowledge-request';
import { Plus } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { DatasetCard } from './dataset-card';
import { DatasetCreatingDialog } from './dataset-creating-dialog';
import { useSaveKnowledge } from './hooks';
import { useRenameDataset } from './use-rename-dataset';
import { useSelectOwners } from './use-select-owners';

export default function Datasets() {
  const {
    visible,
    hideModal,
    showModal,
    onCreateOk,
    loading: creatingLoading,
  } = useSaveKnowledge();
  const list = useFetchNextKnowledgeListByPage();
  const {
    kbs,
    total_datasets,
    pagination,
    setPagination,
    searchString,
    setSearchString,
    filterValue,
    setFilterValue,
    loading,
  } = list;
  const datasets = kbs ?? [];
  const owners = useSelectOwners();
  const rename = useRenameDataset();
  const duplicate = useDuplicateDataset();
  const privilege = useShowPrivilegeDialog();
  const handlePageChange = useCallback(
    (page: number, pageSize?: number) => setPagination({ page, pageSize }),
    [setPagination],
  );
  useGoToPreviousPageOnEmpty(datasets.length, loading, {
    deletionKey: ListDeletionKey.KnowledgeList,
    searchString,
    setSearchString,
    filterValue,
    setFilterValue,
  });
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('isCreate') === 'true') {
      showModal();
      const next = new URLSearchParams(searchParams);
      next.delete('isCreate');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams, showModal]);
  return (
    <>
      <article className="rail-page" data-testid="datasets-list">
        <div className="rail-page-inner">
          <RailPageHeading
            label="知识管理 / KNOWLEDGE"
            title="铁路知识库"
            description="管理铁路资料、解析状态与知识片段。"
          >
            <Button className="rail-primary gap-2" onClick={showModal}>
              <Plus className="size-4" />
              创建知识库
            </Button>
          </RailPageHeading>
          <div>
            <section className="min-w-0" aria-label="知识库目录">
              <ListFilterBar
                className="rail-list-tools"
                title={`全部知识库 · ${total_datasets || 0}`}
                searchString={searchString}
                onSearchChange={list.handleInputChange}
                value={filterValue}
                filters={owners}
                onChange={list.handleFilterSubmit}
              />
              {list.isError ? (
                <RailListState
                  error
                  label="无法读取知识库"
                  detail="请检查服务连接与账号权限。"
                  onRetry={list.refetch}
                />
              ) : loading && !datasets.length ? (
                <RailListState loading label="正在读取知识库" />
              ) : datasets.length ? (
                <>
                  <div className="rail-dataset-columns" aria-hidden>
                    <span>名称 / 资料说明</span>
                    <span>文档</span>
                    <span>知识片段</span>
                    <span>最近更新</span>
                    <span />
                  </div>
                  <div>
                    {datasets.map((dataset) => (
                      <DatasetCard
                        key={dataset.id}
                        dataset={dataset}
                        showDatasetRenameModal={rename.showDatasetRenameModal}
                        showDatasetDuplicateModal={duplicate.showModal}
                        showPrivilegeModal={privilege.handShowPrivilegeModal(
                          dataset,
                        )}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <RailListState
                  label={
                    searchString ||
                    Object.values(filterValue).some((value) => value?.length)
                      ? '没有找到匹配的知识库'
                      : '还没有知识库'
                  }
                >
                  <Button variant="outline" onClick={showModal}>
                    <Plus className="size-4" />
                    创建知识库
                  </Button>
                </RailListState>
              )}
              <footer className="rail-list-footer">
                <RAGFlowPagination
                  current={pagination.current}
                  pageSize={pagination.pageSize}
                  total={total_datasets}
                  onChange={handlePageChange}
                />
              </footer>
            </section>
          </div>
          <div className="rail-page-caption">
            <span>轨知 RailMind</span>
            <span>铁路知识中心</span>
          </div>
        </div>
      </article>
      {visible && (
        <DatasetCreatingDialog
          hideModal={hideModal}
          onOk={onCreateOk}
          loading={creatingLoading}
        />
      )}
      {rename.datasetRenameVisible && (
        <RenameDialog
          hideModal={rename.hideDatasetRenameModal}
          onOk={rename.onDatasetRenameOk}
          initialName={rename.initialDatasetName}
          loading={rename.datasetRenameLoading}
        />
      )}
      {duplicate.isModalVisible && (
        <DuplicateDialog
          hideModal={duplicate.hideModal}
          onOk={duplicate.onOk}
          initialName={duplicate.initialName}
          loading={duplicate.loading}
        />
      )}
      {privilege.privilegeModal && (
        <PrivilegeManagementDialog
          hideModal={privilege.hidePrivilegeModal}
          initialValues={privilege.recordWithSourceType}
        />
      )}
    </>
  );
}
