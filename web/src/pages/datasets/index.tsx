import ListFilterBar from '@/components/list-filter-bar';
import { RenameDialog } from '@/components/rename-dialog';
import { Button } from '@/components/ui/button';
import { RAGFlowPagination } from '@/components/ui/ragflow-pagination';
import { Spin } from '@/components/ui/spin';
import { ListDeletionKey } from '@/constants/list-deletion';
import { useGoToPreviousPageOnEmpty } from '@/hooks/logic-hooks';
import { useFetchNextKnowledgeListByPage } from '@/hooks/use-knowledge-request';
import {
  ArrowUpRight,
  BookOpen,
  FileText,
  FolderOpen,
  Layers3,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
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
  const documents = datasets.reduce(
    (sum, item) => sum + (item.document_count || 0),
    0,
  );
  const chunks = datasets.reduce(
    (sum, item) => sum + (item.chunk_count || 0),
    0,
  );
  return (
    <>
      <article className="rail-page" data-testid="datasets-list">
        <div className="rail-page-inner">
          <header className="rail-page-heading">
            <div>
              <p className="rail-eyebrow">
                知识管理 <span>/</span> KNOWLEDGE
              </p>
              <h1>铁路知识库</h1>
              <p>规章有据可查，知识有源可循。</p>
            </div>
            <Button className="rail-primary gap-2" onClick={showModal}>
              <Plus className="size-4" />
              创建知识库
            </Button>
          </header>
          <div>
            <section className="min-w-0" aria-label="知识库目录">
              <dl className="rail-library-summary">
                <div>
                  <dt>
                    <BookOpen />
                    知识库总数
                  </dt>
                  <dd>
                    {total_datasets || 0}
                    <small>个知识库</small>
                  </dd>
                </div>
                <div>
                  <dt>
                    <FileText />
                    当前页文档
                  </dt>
                  <dd>
                    {documents.toLocaleString()}
                    <small>份资料</small>
                  </dd>
                </div>
                <div>
                  <dt>
                    <Layers3 />
                    当前页知识片段
                  </dt>
                  <dd>
                    {chunks.toLocaleString()}
                    <small>个片段</small>
                  </dd>
                </div>
              </dl>
              <div className="rail-library-tabs">
                <span>
                  <FolderOpen className="size-3.5" />
                  全部知识库<small>{total_datasets || 0}</small>
                </span>
                <Link to="/">
                  前往工作台提问
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </div>
              <ListFilterBar
                className="rail-list-tools"
                title="知识库目录"
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
                  <div className="rail-library-bottom">
                    <ShieldCheck className="size-4" />
                    <span>
                      文档解析完成后，可在铁路工作台中选择知识库进行问答。
                    </span>
                    <Link to="/">
                      开始提问
                      <ArrowUpRight className="size-3.5" />
                    </Link>
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
