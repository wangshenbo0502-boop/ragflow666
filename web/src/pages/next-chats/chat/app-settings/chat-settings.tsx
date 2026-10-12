import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/components/hooks/use-mobile';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Form } from '@/components/ui/form';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DatasetMetadata } from '@/constants/chat';
import { useSetModalState } from '@/hooks/common-hooks';
import { useFetchChat, useUpdateChat } from '@/hooks/use-chat-request';
import { useFindLlmByUuid } from '@/hooks/use-llm-request';
import {
  useRevalidateStaleDatasetIds,
  useStaleDatasetFormSchema,
} from '@/hooks/use-stale-dataset-validation';
import { cn } from '@/lib/utils';
import {
  removeUselessFieldsFromValues,
  setLLMSettingEnabledValues,
} from '@/utils/form';
import { zodResolver } from '@hookform/resolvers/zod';
import { isEmpty, omit } from 'lodash';
import { LucidePanelRightClose, LucideSettings } from 'lucide-react';
import { type KeyboardEvent, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { z } from 'zod';
import ChatBasicSetting from './chat-basic-settings';
import { ChatPromptEngine } from './chat-prompt-engine';
import { SavingButton } from './saving-button';
import { useChatSettingSchema } from './use-chat-setting-schema';
import { useRevealSubmitErrors } from './use-reveal-submit-errors';
import { getWebSearchProvider } from '../web-search-api-key';

type ChatSettingsProps = { hasSingleChatBox: boolean };

export function ChatSettings({ hasSingleChatBox }: ChatSettingsProps) {
  const isMobile = useIsMobile();
  const { data } = useFetchChat();

  const chatSettingSchema = useChatSettingSchema();
  const { formSchema, datasetsFetched } = useStaleDatasetFormSchema(
    chatSettingSchema,
    data?.dataset_ids,
  );
  const { updateChat, loading } = useUpdateChat();
  const findLlmByUuid = useFindLlmByUuid();
  const { id } = useParams();
  const { t } = useTranslation();

  const {
    visible: settingVisible,
    switchVisible: switchSettingVisible,
    showModal: showSettings,
    hideModal: hideSettings,
  } = useSetModalState(false);
  const handleSettingsOpen = (open: boolean) => {
    if (open) showSettings();
    else hideSettings();
  };
  const handleSettingsKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      hideSettings();
    }
  };

  const {
    formContainerRef,
    handleInvalidSubmit,
    modelSettingOpen,
    onModelSettingOpenChange,
    advancedSettingOpen,
    onAdvancedSettingOpenChange,
  } = useRevealSubmitErrors();

  type FormSchemaType = z.infer<typeof formSchema>;

  const form = useForm<FormSchemaType>({
    resolver: zodResolver(formSchema),
    // shouldUnregister: false keeps every field mounted in the form state, which
    // includes all nine per-provider *_api_key fields. Switching provider therefore
    // KEEPS the keys already typed for the others and saves them with the dialog —
    // deliberate (a user may switch back), but it is why the payload can carry more
    // than one provider key.
    shouldUnregister: false,
    mode: 'onChange',
    defaultValues: {
      name: '',
      icon: '',
      description: '',
      dataset_ids: [],
      prompt_config: {
        quote: true,
        keyword: false,
        tts: false,
        refine_multiturn: true,
        system: '',
        parameters: [],
        reasoning: false,
        cross_languages: [],
        reference_metadata: {
          include: false,
          fields: undefined,
        },
      },
      top_n: 8,
      rerank_candidates_count: 64,
      similarity_threshold: 0.2,
      vector_similarity_weight: 0.2,
      meta_data_filter: {
        method: DatasetMetadata.Disabled,
        manual: [],
      },
    },
  });

  async function onSubmit(values: FormSchemaType) {
    const nextValues: Record<string, any> = removeUselessFieldsFromValues(
      values,
      'llm_setting.',
    );
    if (data.prompt_config?.domain === 'railway') {
      nextValues.prompt_config = {
        ...nextValues.prompt_config,
        domain: 'railway',
        railway_scene: data.prompt_config.railway_scene,
        quote: true,
        reasoning: false,
        web_search_provider: '',
      };
    }
    const referenceMetadata = nextValues?.prompt_config?.reference_metadata;
    if (
      referenceMetadata &&
      Array.isArray(referenceMetadata.fields) &&
      referenceMetadata.fields.length === 0
    ) {
      referenceMetadata.fields = undefined;
    }

    // Add model_type to llm_setting based on the selected llm_id
    if (nextValues.llm_id) {
      nextValues.llm_setting = {
        ...nextValues.llm_setting,
        model_type: findLlmByUuid(nextValues.llm_id)?.model_type || 'chat',
      };
    }

    updateChat({
      chatId: id!,
      params: {
        ...omit(data, [
          'operator_permission',
          'tenant_id',
          'tenant_llm_id',
          'tenant_rerank_id',
          'created_by',
          'create_time',
          'create_date',
          'update_time',
          'update_date',
          'id',
          'top_k',
        ]),
        ...nextValues,
      },
    });
  }

  useEffect(() => {
    const llmSettingEnabledValues = setLLMSettingEnabledValues(
      data.llm_setting,
    );
    const referenceMetadata = data?.prompt_config?.reference_metadata;
    const normalizedReferenceMetadata =
      referenceMetadata &&
      Array.isArray(referenceMetadata.fields) &&
      referenceMetadata.fields.length === 0
        ? { ...referenceMetadata, fields: undefined }
        : referenceMetadata;

    const nextData = {
      ...omit(data, 'top_k'),
      prompt_config: {
        ...data.prompt_config,
        // reset() skips undefined values, so fall back to '' to clear the field
        web_search_provider:
          data.prompt_config?.domain === 'railway'
            ? ''
            : (getWebSearchProvider(data.prompt_config) ?? ''),
        reference_metadata: normalizedReferenceMetadata,
      },
      ...llmSettingEnabledValues,
    };

    if (!isEmpty(data)) {
      form.reset(nextData as FormSchemaType);
    }
  }, [data, form]);

  useRevalidateStaleDatasetIds(form, datasetsFetched);

  const panel = (
    <section
      data-testid="chat-detail-settings"
      className={cn(
        'transition-[width] ease-out duration-300 flex-shrink-0 flex flex-col overflow-hidden',
        isMobile ? 'h-full w-full' : settingVisible ? 'w-[440px]' : 'w-0',
      )}
    >
      {settingVisible && (
        <>
          <div className="p-5 pb-2 flex justify-between items-center text-base">
            {t('chat.chatSetting')}

            <Button
              variant="transparent"
              size="icon-sm"
              className="border-0"
              onClick={hideSettings}
              aria-label={t('chat.cancel')}
              data-testid="chat-detail-settings-close"
            >
              <LucidePanelRightClose className="size-4" />
            </Button>
          </div>

          <Form {...form}>
            <form
              ref={formContainerRef}
              onSubmit={form.handleSubmit(onSubmit, handleInvalidSubmit)}
              className="flex-1 flex flex-col min-h-0"
            >
              <ScrollArea
                className="flex-1 min-h-0"
                viewportClassName="[&>div]:!block"
              >
                <section className="p-5 space-y-6 overflow-auto flex-1 min-h-0">
                  <ChatBasicSetting
                    collapseOpen={modelSettingOpen}
                    onCollapseOpenChange={onModelSettingOpenChange}
                  ></ChatBasicSetting>
                  <ChatPromptEngine
                    railway={data.prompt_config?.domain === 'railway'}
                    collapseOpen={advancedSettingOpen}
                    onCollapseOpenChange={onAdvancedSettingOpenChange}
                  ></ChatPromptEngine>
                </section>
              </ScrollArea>

              <div className="shrink-0 p-5 pt-4 space-x-5 text-right">
                <Button
                  type="button"
                  variant={'outline'}
                  onClick={hideSettings}
                  data-testid="chat-detail-settings-cancel"
                >
                  {t('chat.cancel')}
                </Button>
                <SavingButton loading={loading}></SavingButton>
              </div>
            </form>
          </Form>
        </>
      )}
    </section>
  );

  return (
    <>
      {(isMobile || !settingVisible) && (
        <div className="p-3 md:p-5">
          <Button
            onClick={switchSettingVisible}
            disabled={!hasSingleChatBox}
            variant="ghost"
            size="icon-sm"
            aria-label={t('chat.chatSetting')}
            title={t('chat.chatSetting')}
            data-testid="chat-settings"
          >
            <LucideSettings />
          </Button>
        </div>
      )}
      {isMobile ? (
        <Sheet open={settingVisible} onOpenChange={handleSettingsOpen}>
          <SheetContent
            side="right"
            className="w-full max-w-full p-0"
            closeIcon={false}
            onKeyDown={handleSettingsKeyDown}
          >
            <SheetTitle className="sr-only">{t('chat.chatSetting')}</SheetTitle>
            {panel}
          </SheetContent>
        </Sheet>
      ) : (
        panel
      )}
    </>
  );
}
