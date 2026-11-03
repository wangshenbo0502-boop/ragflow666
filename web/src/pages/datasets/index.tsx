import ListFilterBar from '@/components/list-filter-bar';
import { RenameDialog } from '@/components/rename-dialog';
import { Button } from '@/components/ui/button';
import { RAGFlowPagination } from '@/components/ui/ragflow-pagination';
import { Spin } from '@/components/ui/spin';
import { ListDeletionKey } from '@/constants/list-deletion';
import { useRailMotion } from '@/hooks/use-rail-motion';
import { useGoToPreviousPageOnEmpty } from '@/hooks/logic-hooks';
import { useFetchNextKnowledgeListByPage } from '@/hooks/use-knowledge-request';
import { FolderOpen, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { DatasetCard } from './dataset-card';
import { DatasetCreatingDialog } from './dataset-creating-dialog';
import { useSaveKnowledge } from './hooks';
import { useRenameDataset } from './use-rename-dataset';
import { useSelectOwners } from './use-select-owners';

export default function Datasets() {
  const pageRef = useRef<HTMLElement>(null);
  useRailMotion(pageRef);
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
      <article ref={pageRef} className="rail-page" data-testid="datasets-list">
        <div className="rail-page-inner">
          <header className="rail-page-heading">
            <div>
              <p className="rail-eyebrow">
                知识管理 <span>/</span> KNOWLEDGE
              </p>
              <h1>铁路知识库。</h1>
              <p>每一份知识，都有来处。</p>
            </div>
            <Button className="rail-primary gap-2" onClick={showModal}>
              <Plus className="size-4" />
              创建知识库
            </Button>
          </header>
          <div>
            <section
              className="min-w-0"
              aria-label="知识库目录"
              data-rail-reveal
            >
              <ListFilterBar
                className="rail-list-tools"
                title={`全部知识库 · ${total_datasets || 0}`}
                searchString={searchString}
                onSearchChange={list.handleInputChange}
                value={filterValue}
                filters={owners}
                onChange={list.handleFilterSubmit}
              />
              {loading && !datasets.length ? (
                <div className="rail-empty">
                  <Spin size="large" />
                </div>
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
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div className="rail-empty">
                  <FolderOpen className="size-9" />
                  <h2>
                    {searchString ||
                    Object.values(filterValue).some((value) => value?.length)
                      ? '没有找到匹配的知识库'
                      : '还没有知识库'}
                  </h2>
                  <p>添加铁路资料，建立你的知识目录。</p>
                  <Button variant="outline" onClick={showModal}>
                    <Plus className="size-4" />
                    创建知识库
                  </Button>
                </div>
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
    </>
  );
}
