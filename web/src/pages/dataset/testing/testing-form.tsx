'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { CrossLanguageFormField } from '@/components/cross-language-form-field';
import { FormContainer } from '@/components/form-container';
import {
  RerankCandidatesCountFormField,
  rerankCandidatesCountSchema,
} from '@/components/rerank-candidates-count-item';
import {
  MetadataFilter,
  MetadataFilterSchema,
} from '@/components/metadata-filter';
import { RerankFormFields } from '@/components/rerank';
import {
  SimilaritySliderFormField,
  initialSimilarityThresholdValue,
  initialVectorSimilarityWeightValue,
  similarityThresholdSchema,
  vectorSimilarityWeightSchema,
} from '@/components/similarity-slider';
import { TopSelectFormItem } from '@/components/top-select';
import { ButtonLoading } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';

import { useTestRetrieval } from '@/hooks/use-knowledge-request';
import { ITestRetrievalRequestBody } from '@/interfaces/request/knowledge';
import { trim } from 'lodash';
import { Send } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { useOwnerTenantId } from '../contexts/knowledge-base-context';

type TestingFormProps = Pick<
  ReturnType<typeof useTestRetrieval>,
  'loading' | 'refetch' | 'setValues'
>;

export default function TestingForm({
  loading,
  refetch,
  setValues,
}: TestingFormProps) {
  const { t } = useTranslation();
  const { id } = useParams();
  const ownerTenantId = useOwnerTenantId();
  const knowledgeBaseId = id;

  const formSchema = z
    .object({
      question: z.string().min(1, {
        message: t('knowledgeDetails.testTextPlaceholder'),
      }),
      ...similarityThresholdSchema,
      ...vectorSimilarityWeightSchema,
      dataset_ids: z.array(z.string()).optional(),
      ...MetadataFilterSchema,
      page_size: z.number().int().min(1).max(100),
      ...rerankCandidatesCountSchema,
    })
    .refine((values) => values.rerank_candidates_count >= values.page_size, {
      message: t('chat.rerankCandidatesCountValidation'),
      path: ['rerank_candidates_count'],
    });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      ...initialSimilarityThresholdValue,
      ...initialVectorSimilarityWeightValue,
      dataset_ids: [knowledgeBaseId],
      page_size: 10,
      rerank_candidates_count: 64,
    },
  });

  const question = form.watch('question');

  const values = useWatch({ control: form.control });

  useEffect(() => {
    setValues(values as ITestRetrievalRequestBody);
  }, [setValues, values]);

  function onSubmit() {
    refetch();
  }

  function handleQuestionKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      form.handleSubmit(onSubmit)();
    }
  }

  return (
    <Form {...form}>
      <form
        className="rail-retrieval-form"
        onSubmit={form.handleSubmit(onSubmit)}
      >
        <FormContainer className="rail-retrieval-fields">
          <SimilaritySliderFormField
            isTooltipShown={true}
          ></SimilaritySliderFormField>
          <RerankFormFields ownerTenantId={ownerTenantId}></RerankFormFields>
          <CrossLanguageFormField
            name={'cross_languages'}
          ></CrossLanguageFormField>
          <MetadataFilter prefix=""></MetadataFilter>
          <RerankCandidatesCountFormField></RerankCandidatesCountFormField>
          <TopSelectFormItem></TopSelectFormItem>
        </FormContainer>
        <footer>
          <FormField
            control={form.control}
            name="question"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Textarea
                    {...field}
                    onKeyDown={handleQuestionKeyDown}
                  ></Textarea>
                </FormControl>

                <FormMessage />
              </FormItem>
            )}
          />

          <div className="mt-2.5 text-end">
            <ButtonLoading
              type="submit"
              disabled={!trim(question)}
              loading={loading}
            >
              {t('knowledgeDetails.testingLabel')}
              <Send />
            </ButtonLoading>
          </div>
        </footer>
      </form>
    </Form>
  );
}
