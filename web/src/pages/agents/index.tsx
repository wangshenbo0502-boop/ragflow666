import { CardContainer } from '@/components/card-container';
import ListFilterBar from '@/components/list-filter-bar';
import { RailListState } from '@/components/rail-list-state';
import { RailPageHeading } from '@/components/rail-page-heading';
import { PrivilegeManagementDialog } from '@/ee/components/privilege-management/privilege-management-dialog';
import { RenameDialog } from '@/components/rename-dialog';
import { RAGFlowPagination } from '@/components/ui/ragflow-pagination';
import { ListDeletionKey } from '@/constants/list-deletion';
import { useGoToPreviousPageOnEmpty } from '@/hooks/logic-hooks';
import { useNavigatePage } from '@/hooks/logic-hooks/navigate-hooks';
import { useFetchAgentListByPage } from '@/hooks/use-agent-request';
import { useDeleteCompilationTemplateGroup } from '@/hooks/use-compilation-template-group-request';
import { AgentListItemType } from '@/interfaces/database/agent';
import { pick } from 'lodash';
import { Workflow } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AgentCard } from './agent-card';
import {
  AgentCreateMenu,
  AgentsEmptyStateActions,
} from './agent-create-actions';
import { AgentTabGroup } from './agent-tab-group';
import { BuiltinCatalogProbe } from './builtin-catalog-probe';
import { BuiltinPipelineSection } from './builtin-pipeline-section';
import {
  resolveAgentsEmptyState,
  shouldShowBuiltinForCategory,
} from './builtin-pipeline-list';
import { CompilationTemplateCard } from './compilation-template-card';
import { FlowType } from './constant';
import { CreateAgentDialog } from './create-agent-dialog';
import { useAgentCreateActions } from './hooks/use-agent-create-actions';
import { useAgentTab } from './hooks/use-agent-tab';
import { useCreateAgentOrPipeline } from './hooks/use-create-agent';
import { useSelectFilters } from './hooks/use-select-filters';
import { UploadAgentDialog } from './upload-agent-dialog';
import { useHandleImportJsonFile } from './use-import-json';
import { useRenameAgent } from './use-rename-agent';
import { useShowPrivilegeDialog } from '@/ee/pages/agents/use-show-privilege-dialog';

export default function Agents() {
  const {
    searchUrl,
    setSearchUrl,
    activeCategory,
    activeType,
    handleTabChange,
  } = useAgentTab();

  const {
    data,
    loading: listLoading,
    isError,
    refetch,
    pagination,
    setPagination,
    searchString,
    setSearchString,
    handleInputChange,
    filterValue,
    setFilterValue,
    handleFilterSubmit,
    checkValue,
    debouncedSearchString,
  } = useFetchAgentListByPage(activeCategory);

  // Built-in pipelines are parsing methods => dataflow canvases, so the section
  // (and its catalog request) is mounted only for the Pipeline tab.
  const builtinVisible = shouldShowBuiltinForCategory(activeCategory);

  // Lifted filtered built-in catalog state, reported by BuiltinCatalogProbe so
  // the empty-state decision can use *matched* built-in items rather than just
  // category eligibility.
  const [builtinState, setBuiltinState] = useState<{
    length: number;
    loading: boolean;
  }>({ length: 0, loading: false });

  useEffect(() => {
    if (!builtinVisible) {
      setBuiltinState({ length: 0, loading: false });
    }
  }, [builtinVisible]);

  const {
    agentRenameLoading,
    initialAgentName,
    onAgentRenameOk,
    agentRenameVisible,
    hideAgentRenameModal,
    showAgentRenameModal,
  } = useRenameAgent();

  const {
    creatingVisible,
    hideCreatingModal,
    showCreatingModal,
    loading,
    handleCreateAgentOrPipeline,
  } = useCreateAgentOrPipeline();

  const {
    handleImportJson,
    fileUploadVisible,
    onFileUploadOk,
    hideFileUploadModal,
  } = useHandleImportJsonFile(activeCategory);

  const createActions = useAgentCreateActions(
    activeType,
    activeCategory,
    showCreatingModal,
    handleImportJson,
  );

  const {
    privilegeModalVisible,
    hidePrivilegeModal,
    handShowPrivilegeModal,
    recordWithSourceType,
  } = useShowPrivilegeDialog();
  const { deleteGroup } = useDeleteCompilationTemplateGroup();

  const filters = useSelectFilters(activeCategory);

  useEffect(() => {
    checkValue(filters);
  }, [filters, checkValue]);

  const handlePageChange = useCallback(
    (page: number, pageSize?: number) => {
      setPagination({ page, pageSize });
    },
    [setPagination],
  );
  useGoToPreviousPageOnEmpty(data?.length, listLoading, {
    deletionKey: ListDeletionKey.AgentList,
    searchString,
    setSearchString,
    filterValue,
    setFilterValue,
  });

  const { navigateToCompilationEditor } = useNavigatePage();

  const handleCreateCompilation = useCallback(() => {
    navigateToCompilationEditor();
  }, [navigateToCompilationEditor]);

  const handleEditCompilation = useCallback(
    (id: string) => () => {
      navigateToCompilationEditor(id);
    },
    [navigateToCompilationEditor],
  );

  const handleDeleteCompilation = useCallback(
    async (id: string) => {
      await deleteGroup(id);
    },
    [deleteGroup],
  );

  const isCreate = searchUrl.get('isCreate') === 'true';

  useEffect(() => {
    if (isCreate) {
      showCreatingModal();
      const nextParams = new URLSearchParams(searchUrl);
      nextParams.delete('isCreate');
      setSearchUrl(nextParams, { replace: true });
    }
  }, [isCreate, showCreatingModal, searchUrl, setSearchUrl]);

  const emptyState = resolveAgentsEmptyState({
    dataLength: data.length,
    builtinItemsLength: builtinState.length,
    searchString: debouncedSearchString,
    listLoading,
    builtinVisible,
    builtinLoading: builtinState.loading,
  });

  return (
    <>
      {builtinVisible && (
        <BuiltinCatalogProbe
          canvasCategory={activeCategory}
          searchString={debouncedSearchString}
          onReport={setBuiltinState}
        />
      )}
      <article className="rail-page rail-agents" data-testid="agents-list">
        <div className="rail-page-inner">
          <RailPageHeading
            label="自动化 / AUTOMATION"
            title="智能应用"
            description="管理工作流、摄取管道与编译算子。"
          >
            <AgentCreateMenu
              actions={createActions}
              directOnClick={
                activeType === FlowType.Compiler
                  ? handleCreateCompilation
                  : undefined
              }
            />
          </RailPageHeading>
          <ListFilterBar
            className="rail-list-tools rail-agent-tools"
            searchString={searchString}
            onSearchChange={handleInputChange}
            filters={filters}
            onChange={handleFilterSubmit}
            value={filterValue}
            leftPanel={
              <AgentTabGroup
                activeCategory={activeCategory}
                onTabChange={handleTabChange}
              />
            }
          />

          {isError && (
            <RailListState
              error
              label="无法读取智能应用"
              detail="请检查服务连接与账号权限。"
              onRetry={refetch}
            />
          )}
          {emptyState === 'content' ? (
            <>
              <CardContainer className="rail-agent-list">
                {data.map((x) =>
                  x.type === AgentListItemType.CompilationTemplateGroup ? (
                    <CompilationTemplateCard
                      key={x.id}
                      data={x}
                      onClick={handleEditCompilation(x.id)}
                      onDelete={handleDeleteCompilation}
                    />
                  ) : (
                    <AgentCard
                      key={x.id}
                      data={x}
                      showAgentRenameModal={showAgentRenameModal}
                      showPrivilegeModal={handShowPrivilegeModal(x)}
                    />
                  ),
                )}

                {builtinVisible && (
                  <BuiltinPipelineSection
                    canvasCategory={activeCategory}
                    searchString={debouncedSearchString}
                    showDivider={data.length > 0}
                  />
                )}
              </CardContainer>

              {data.length > 0 && (
                <footer className="rail-list-footer">
                  <RAGFlowPagination
                    {...pick(pagination, 'current', 'pageSize')}
                    total={pagination.total}
                    onChange={handlePageChange}
                  />
                </footer>
              )}
            </>
          ) : isError ? null : emptyState === 'loading' ? (
            <RailListState loading label="正在读取智能应用" />
          ) : emptyState === 'search-empty' ||
            Object.values(filterValue ?? {}).some((value) => value?.length) ? (
            <RailListState
              testId="agents-search-empty"
              icon={Workflow}
              label="没有找到匹配的应用"
            />
          ) : (
            <RailListState icon={Workflow} label="还没有智能应用">
              <AgentsEmptyStateActions actions={createActions} />
            </RailListState>
          )}
        </div>
      </article>

      {agentRenameVisible && (
        <RenameDialog
          hideModal={hideAgentRenameModal}
          onOk={onAgentRenameOk}
          initialName={initialAgentName}
          loading={agentRenameLoading}
        ></RenameDialog>
      )}
      {creatingVisible && (
        <CreateAgentDialog
          loading={loading}
          visible={creatingVisible}
          hideModal={hideCreatingModal}
          selectedType={activeType}
          onOk={handleCreateAgentOrPipeline}
        ></CreateAgentDialog>
      )}
      {fileUploadVisible && (
        <UploadAgentDialog
          hideModal={hideFileUploadModal}
          onOk={onFileUploadOk}
        ></UploadAgentDialog>
      )}
      {privilegeModalVisible && (
        <PrivilegeManagementDialog
          hideModal={hidePrivilegeModal}
          initialValues={recordWithSourceType}
        ></PrivilegeManagementDialog>
      )}
    </>
  );
}
