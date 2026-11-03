import { MoreButton } from '@/components/more-button';
import { IDataset } from '@/interfaces/database/dataset';
import { Routes } from '@/routes';
import dayjs from 'dayjs';
import { BookOpenText } from 'lucide-react';
import { Link } from 'react-router';
import { DatasetDropdown } from './dataset-dropdown';
import { useRenameDataset } from './use-rename-dataset';

type DatasetCardProps = { dataset: IDataset } & Pick<
  ReturnType<typeof useRenameDataset>,
  'showDatasetRenameModal'
>;

export function DatasetCard({
  dataset,
  showDatasetRenameModal,
}: DatasetCardProps) {
  return (
    <article className="rail-dataset-row group">
      <Link
        to={`${Routes.Dataset}/${dataset.id}`}
        className="rail-dataset-title"
      >
        <span className="rail-dataset-icon">
          <BookOpenText className="size-5" />
        </span>
        <div className="min-w-0">
          <h2>{dataset.name}</h2>
          <p>
            {dataset.description ||
              `${dataset.document_count || 0} 份文档 · ${dataset.nickname || '个人知识库'}`}
          </p>
        </div>
      </Link>
      <span className="rail-dataset-number">{dataset.document_count || 0}</span>
      <span className="rail-dataset-number">
        {(dataset.chunk_count || 0).toLocaleString()}
      </span>
      <time className="rail-dataset-date">
        {dataset.update_time
          ? dayjs(dataset.update_time).format('YYYY.MM.DD')
          : '—'}
      </time>
      <DatasetDropdown
        dataset={dataset}
        showDatasetRenameModal={showDatasetRenameModal}
      >
        <MoreButton
          className="!opacity-100 !size-7"
          aria-label={`${dataset.name}的操作`}
        />
      </DatasetDropdown>
    </article>
  );
}
