import { useTestRetrieval } from '@/hooks/use-knowledge-request';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { t } from 'i18next';
import { Info } from 'lucide-react';
import TestingForm from './testing-form';
import { TestingResult } from './testing-result';

export default function RetrievalTesting() {
  const { loading, setValues, refetch, data, handleFilterSubmit, filterValue } =
    useTestRetrieval();

  return (
    <article className="rail-retrieval">
      <header>
        <h1>{t('knowledgeDetails.retrievalTesting')}</h1>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-text-secondary p-2"
              aria-label={t('knowledgeDetails.testingDescription')}
            >
              <Info className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-80 leading-relaxed">
            {t('knowledgeDetails.testingDescription')}
          </TooltipContent>
        </Tooltip>
      </header>
      <div className="rail-retrieval-grid">
        <section>
          <h2>{t('knowledgeDetails.testSetting')}</h2>
          <TestingForm
            loading={loading}
            setValues={setValues}
            refetch={refetch}
          />
        </section>
        <section aria-label={t('knowledgeDetails.retrievalTesting')}>
          <TestingResult
            data={data}
            loading={loading}
            filterValue={filterValue}
            handleFilterSubmit={handleFilterSubmit}
          />
        </section>
      </div>
    </article>
  );
}
