import { TruncatedText } from '@/components/truncated-text';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { DocumentParserType } from '@/constants/knowledge';
import {
  useFetchDatasetsByIds,
  useFetchKnowledgeList,
} from '@/hooks/use-knowledge-request';
import { IDialog } from '@/interfaces/database/chat';
import { IDataset } from '@/interfaces/database/dataset';
import { getEmbeddingBaseName } from '@/utils/llm-util';
import { useDebounce } from 'ahooks';
import { BookOpen, Check, ChevronDown, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useComposerSettings } from './use-composer-settings';

export function datasetIsDisabled(
  dataset: IDataset,
  embeddingName: string,
  selected: boolean,
) {
  if (selected) return false;
  return (
    dataset.chunk_count === 0 ||
    dataset.chunk_method === DocumentParserType.Tag ||
    (!!embeddingName &&
      getEmbeddingBaseName(
        dataset.embedding_model_name || dataset.embedding_model,
      ) !== embeddingName)
  );
}

function DatasetOption({
  dataset,
  selected,
  disabled,
  onSelect,
}: {
  dataset: IDataset;
  selected: boolean;
  disabled: boolean;
  onSelect(id: string): void;
}) {
  const handleSelect = useCallback(
    () => onSelect(dataset.id),
    [dataset.id, onSelect],
  );
  return (
    <CommandItem
      value={dataset.id}
      keywords={[dataset.name]}
      onSelect={handleSelect}
      disabled={disabled}
      aria-selected={selected}
      className="min-h-10 text-text-primary data-[selected=true]:text-text-primary"
    >
      <BookOpen className="text-text-secondary" />
      <TruncatedText
        as="span"
        className="min-w-0 flex-1 truncate"
        tooltip={dataset.name}
      >
        {dataset.name}
      </TruncatedText>
      {selected && <Check className="ml-auto text-accent-primary" />}
    </CommandItem>
  );
}

function DatasetOptions({
  selectedIds,
  selectedDatasets,
  disabled,
  onSelect,
}: {
  selectedIds: string[];
  selectedDatasets: IDataset[];
  disabled: boolean;
  onSelect(id: string): void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const keywords = useDebounce(search, { wait: 250 });
  const { list, loading, handleScroll, hasNextPage } = useFetchKnowledgeList(
    false,
    keywords,
  );
  const embedding = selectedDatasets.find((item) =>
    selectedIds.includes(item.id),
  );
  const embeddingName = getEmbeddingBaseName(
    embedding?.embedding_model_name || embedding?.embedding_model,
  );
  const datasets = useMemo(
    () =>
      Array.from(
        new Map(
          [...selectedDatasets, ...list].map((item) => [item.id, item]),
        ).values(),
      ).filter((item) =>
        item.name.toLowerCase().includes(search.toLowerCase()),
      ),
    [list, selectedDatasets, search],
  );
  return (
    <Command shouldFilter={false} className="border-0">
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={t('chat.searchDatasets')}
      />
      <CommandList
        className="max-h-64"
        onScroll={hasNextPage ? handleScroll : undefined}
      >
        {!loading && <CommandEmpty>{t('common.noDataFound')}</CommandEmpty>}
        <CommandGroup className="text-text-primary">
          {datasets.map((dataset) => (
            <DatasetOption
              key={dataset.id}
              dataset={dataset}
              selected={selectedIds.includes(dataset.id)}
              disabled={
                disabled ||
                datasetIsDisabled(
                  dataset,
                  embeddingName,
                  selectedIds.includes(dataset.id),
                )
              }
              onSelect={onSelect}
            />
          ))}
        </CommandGroup>
        {loading && (
          <div role="status" className="flex justify-center p-3">
            <Loader2 className="size-4 animate-spin text-text-secondary" />
          </div>
        )}
      </CommandList>
    </Command>
  );
}

export function ComposerDatasetSelect({
  dialog,
  saving,
  disabled,
  saveSettings,
}: {
  dialog: IDialog;
  saving: boolean;
  disabled: boolean;
  saveSettings: ReturnType<typeof useComposerSettings>['saveSettings'];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ids = useMemo(() => dialog.dataset_ids ?? [], [dialog.dataset_ids]);
  const { data: selectedDatasets = [], loading } = useFetchDatasetsByIds(ids);
  const label =
    ids.length === 1
      ? selectedDatasets.find((item) => item.id === ids[0])?.name ||
        dialog.kb_names?.[0] ||
        t('chat.knowledgeBases')
      : ids.length > 1
        ? t('chat.selectedDatasets', { count: ids.length })
        : t('chat.noDatasets');
  const handleSelect = useCallback(
    async (id: string) => {
      await saveSettings({
        dataset_ids: ids.includes(id)
          ? ids.filter((value) => value !== id)
          : [...ids, id],
      });
    },
    [ids, saveSettings],
  );
  const handleClear = useCallback(async () => {
    const saved = await saveSettings({ dataset_ids: [] });
    if (saved) setOpen(false);
  }, [saveSettings]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || saving || loading}
          aria-label={t('chat.knowledgeBases')}
          aria-expanded={open}
          data-testid="chat-composer-datasets"
          className="h-8 w-full min-w-0 justify-start gap-1 px-1.5"
        >
          <BookOpen className="size-3.5 shrink-0" />
          <TruncatedText as="span" className="min-w-0 truncate" tooltip={label}>
            {label}
          </TruncatedText>
          <ChevronDown className="ml-auto size-3.5 shrink-0 max-[380px]:hidden" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] p-1.5"
      >
        {open && (
          <DatasetOptions
            selectedIds={ids}
            selectedDatasets={selectedDatasets}
            disabled={disabled || saving || loading}
            onSelect={handleSelect}
          />
        )}
        <div className="flex items-center justify-between gap-2 border-t border-border-button px-2 pt-2">
          <span aria-live="polite" className="text-xs text-text-secondary">
            {t('chat.selectedDatasets', { count: ids.length })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!ids.length || disabled || saving}
            onClick={handleClear}
          >
            {t('chat.clearDatasets')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
