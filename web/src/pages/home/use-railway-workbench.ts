import { useFetchDefaultModelDictionary } from '@/hooks/use-llm-request';
import { IngestionTaskStatus } from '@/constants/knowledge';
import { useFetchUserInfo } from '@/hooks/use-user-setting-request';
import type { RailwayScene } from '@/interfaces/database/railway';
import {
  createRailwayChat,
  importRailwaySources,
  listRailwayDatasets,
  listRailwayDocuments,
  listRailwaySources,
  RailwayDatasetName,
} from '@/services/railway-service';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { buildRailwayQuestion, EmptyEquipmentContext } from './railway-question';

const RailwayKeys = {
  datasets: () => ['railway', 'datasets'] as const,
  sources: () => ['railway', 'sources'] as const,
  documents: (id: string) => ['railway', 'documents', id] as const,
};

export function useRailwayWorkbench() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const models = useFetchDefaultModelDictionary();
  const { data: user } = useFetchUserInfo();
  const [datasetId, setDatasetId] = useState('');
  const [scene, setScene] = useState<RailwayScene>('safety');
  const [progress, setProgress] = useState('');
  const [question, setQuestion] = useState('');
  const [equipment, setEquipment] = useState(EmptyEquipmentContext);
  const sources = useQuery({
    queryKey: RailwayKeys.sources(),
    queryFn: listRailwaySources,
  });
  const datasets = useQuery({
    queryKey: RailwayKeys.datasets(),
    queryFn: listRailwayDatasets,
    refetchInterval: 10000,
  });
  const selectedId =
    datasetId ||
    datasets.data?.find(
      (item) =>
        item.name === RailwayDatasetName && item.tenant_id === user.id,
    )?.id ||
    datasets.data?.find((item) => item.chunk_count > 0)?.id ||
    '';
  const documents = useQuery({
    queryKey: RailwayKeys.documents(selectedId),
    queryFn: () => listRailwayDocuments(selectedId),
    enabled: !!selectedId,
    refetchInterval: 5000,
  });
  const initialize = useMutation({
    mutationFn: () =>
      importRailwaySources(models.embd_id, user.id, setProgress),
    onSuccess: (id) => setDatasetId(id),
    onSettled: async (id) => {
      await client.invalidateQueries({ queryKey: RailwayKeys.datasets() });
      await client.invalidateQueries({
        queryKey: RailwayKeys.documents(id || selectedId),
      });
    },
  });
  const start = useMutation({
    mutationFn: () => createRailwayChat(selectedId, models.llm_id, scene),
    onSuccess: (chat) =>
      navigate(`/chat/${chat.id}`, {
        state: {
          railwayQuestion: buildRailwayQuestion(scene, question, equipment),
        },
      }),
  });
  const selected = datasets.data?.find((item) => item.id === selectedId);
  const readyDocumentCount =
    documents.data?.filter(
      (document) =>
        document.ingestion_status === IngestionTaskStatus.COMPLETED &&
        document.chunk_count > 0,
    ).length || 0;
  const hasReadyDocuments = readyDocumentCount > 0;
  return {
    sources,
    datasets,
    documents,
    initialize,
    start,
    scene,
    setScene,
    selectedId,
    setDatasetId,
    progress,
    readyDocumentCount,
    models,
    question,
    setQuestion,
    equipment,
    setEquipment,
    canStart:
      !!models.llm_id &&
      !!selected &&
      selected.chunk_count > 0 &&
      hasReadyDocuments,
  };
}
