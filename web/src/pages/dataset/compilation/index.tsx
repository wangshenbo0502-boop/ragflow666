import BackButton from '@/components/back-button';
import {
  SelectWithSearch,
  type SelectWithSearchFlagOptionType,
} from '@/components/originui/select-with-search';
import { RAGFlowAvatar } from '@/components/ragflow-avatar';
import { Button } from '@/components/ui/button';
import { useNavigatePage } from '@/hooks/logic-hooks/navigate-hooks';
import { useFetchKnowledgeBaseConfiguration } from '@/hooks/use-knowledge-request';
import { Routes } from '@/routes';
import { LucideFilePlus2, LucideLogs, LucideSettings2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import {
  StructureKinds,
  ViewMode,
  ViewModeLabelKeyMap,
  VisibleViewModes,
} from './constants';
import { DatasetStructureView } from './dataset-structure-view';
import { LlmWikiView } from './llm-wiki-view';
import { NavTreeView } from './nav-tree-view';
import { SkillsView } from './skills-view';

export default function Compilation() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { navigateToDataFile } = useNavigatePage();
  const { data: knowledgeBase } = useFetchKnowledgeBaseConfiguration();
  const [viewMode, setViewMode] = useState<ViewMode>(ViewMode.LlmWiki);
  const datasetRoute = `${Routes.DatasetBase}`;

  const viewOptions = useMemo<SelectWithSearchFlagOptionType[]>(() => {
    return VisibleViewModes.map((mode) => ({
      value: mode,
      label: t(ViewModeLabelKeyMap[mode]),
    }));
  }, [t]);

  const handleViewModeChange = useCallback((value: string) => {
    setViewMode(value as ViewMode);
  }, []);

  const structureKind = StructureKinds.find((kind) => kind === viewMode);

  return (
    <section className="rail-wiki-page">
      <header className="rail-wiki-page-header">
        <div className="rail-wiki-toolbar">
          <BackButton onClick={navigateToDataFile(id!)}>
            {t('common.back')}
          </BackButton>
          <nav
            aria-label={t('knowledgeCompilation.artifacts')}
            className="rail-wiki-actions"
          >
            <Button
              asLink
              to={`${datasetRoute}${Routes.DataSetSetting}/${id}`}
              variant="outline"
              size="sm"
            >
              <LucideSettings2 />
              {t('knowledgeCompilation.configureDataset')}
            </Button>
            <Button
              asLink
              to={`${datasetRoute}${Routes.Files}/${id}`}
              variant="outline"
              size="sm"
            >
              <LucideFilePlus2 />
              {t('knowledgeCompilation.parseDocuments')}
            </Button>
            <Button
              asLink
              to={`${datasetRoute}${Routes.DataSetOverview}/${id}`}
              variant="outline"
              size="sm"
            >
              <LucideLogs />
              {t('knowledgeCompilation.viewLogs')}
            </Button>
          </nav>
        </div>

        <section className="rail-wiki-heading">
          <div className="flex items-center gap-3">
            <RAGFlowAvatar
              avatar={knowledgeBase?.avatar}
              name={knowledgeBase?.name}
              className="size-10 rounded-lg"
            />
            <div className="min-w-0">
              <p className="rail-eyebrow">
                {t('knowledgeCompilation.artifacts')} <span>/</span>{' '}
                {t('knowledgeCompilation.llmWiki')}
              </p>
              <h1>
                <span className="truncate">
                  {knowledgeBase?.name}
                  {t('knowledgeCompilation.compilationTitleSuffix')}
                </span>
              </h1>
            </div>
          </div>

          <SelectWithSearch
            options={viewOptions}
            value={viewMode}
            onChange={handleViewModeChange}
            triggerClassName="rail-wiki-mode-select"
          />
        </section>
      </header>

      <div className="rail-wiki-workspace">
        {viewMode === ViewMode.LlmWiki && <LlmWikiView />}
        {viewMode === ViewMode.Skills && <SkillsView />}
        {viewMode === ViewMode.Tree && <NavTreeView />}
        {structureKind && <DatasetStructureView kind={structureKind} />}
      </div>
    </section>
  );
}
