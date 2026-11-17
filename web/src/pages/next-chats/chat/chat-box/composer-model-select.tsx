import { useModelTree } from '@/components/model-tree-select';
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
import { IDialog } from '@/interfaces/database/chat';
import { IAddedModel } from '@/interfaces/database/llm';
import { buildModelValue, getRealModelName } from '@/utils/llm-util';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useComposerSettings } from './use-composer-settings';

export function isSelectableChatModel(model: IAddedModel) {
  return (
    !/astra|gpt-image/i.test(model.name) &&
    model.status !== 'inactive' &&
    model.instance_status !== 'inactive'
  );
}

function modelReference(model: IAddedModel) {
  return (
    model.model_id ||
    buildModelValue({
      model_name: getRealModelName(model.name),
      model_instance: model.instance_name,
      model_provider: model.provider_name,
    })
  );
}

function ModelOption({
  model,
  selected,
  disabled,
  onSelect,
}: {
  model: IAddedModel;
  selected: boolean;
  disabled: boolean;
  onSelect(model: IAddedModel): void;
}) {
  const handleSelect = useCallback(() => onSelect(model), [model, onSelect]);
  const name = getRealModelName(model.name);
  return (
    <CommandItem
      value={modelReference(model)}
      keywords={[name, model.provider_name, model.instance_name]}
      onSelect={handleSelect}
      disabled={disabled}
      aria-selected={selected}
      className="min-h-10 text-text-primary data-[selected=true]:text-text-primary"
    >
      <TruncatedText
        as="span"
        className="min-w-0 flex-1 truncate"
        tooltip={name}
      >
        {name}
      </TruncatedText>
      {selected && <Check className="ml-auto text-accent-primary" />}
    </CommandItem>
  );
}

export function ComposerModelSelect({
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
  const { models, isFetched, isError } = useModelTree({
    ownerTenantId: dialog.tenant_id,
  });
  const selectableModels = useMemo(
    () => models.filter(isSelectableChatModel),
    [models],
  );
  const selected = selectableModels.find(
    (model) =>
      modelReference(model) === (dialog.tenant_llm_id || dialog.llm_id) ||
      buildModelValue({
        model_name: getRealModelName(model.name),
        model_instance: model.instance_name,
        model_provider: model.provider_name,
      }) === dialog.llm_id,
  );
  const groups = useMemo(() => {
    const result = new Map<string, IAddedModel[]>();
    for (const model of selectableModels) {
      const key = `${model.provider_name} / ${model.instance_name}`;
      result.set(key, [...(result.get(key) ?? []), model]);
    }
    return Array.from(result);
  }, [selectableModels]);
  const selectedName = selected
    ? getRealModelName(selected.name)
    : dialog.llm_id?.split('@')[0] || t('chat.chooseModel');

  const handleSelect = useCallback(
    async (model: IAddedModel) => {
      if (selected && modelReference(model) === modelReference(selected)) {
        setOpen(false);
        return;
      }
      const saved = await saveSettings({
        llm_id: modelReference(model),
        llm_setting: {
          ...dialog.llm_setting,
          model_type: model.model_type.includes('vision') ? 'vision' : 'chat',
        },
      });
      if (saved) setOpen(false);
    },
    [saveSettings, dialog.llm_setting, selected],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || saving || !isFetched || isError}
          aria-label={t('chat.chooseModel')}
          aria-expanded={open}
          data-testid="chat-composer-model"
          className="min-w-0 max-w-44 shrink gap-1.5"
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          <TruncatedText
            as="span"
            className="min-w-0 truncate"
            tooltip={selectedName}
          >
            {selectedName}
          </TruncatedText>
          <ChevronDown className="size-3.5 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)] p-1.5"
      >
        <Command className="border-0">
          <CommandInput placeholder={t('chat.chooseModel')} />
          <CommandList className="max-h-72">
            <CommandEmpty>{t('chat.noChatModels')}</CommandEmpty>
            {groups.map(([name, groupModels]) => (
              <CommandGroup
                key={name}
                className="text-text-primary"
                heading={
                  <span className="block truncate" title={name}>
                    {name}
                  </span>
                }
              >
                {groupModels.map((model) => (
                  <ModelOption
                    key={modelReference(model)}
                    model={model}
                    selected={selected === model}
                    disabled={saving || disabled}
                    onSelect={handleSelect}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
