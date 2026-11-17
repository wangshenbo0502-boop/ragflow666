import { hasEditPermission } from '@/ee/utils/permission-util';
import { useFetchChat, usePatchChat } from '@/hooks/use-chat-request';
import { IDialog } from '@/interfaces/database/chat';
import { useCallback, useRef, useState } from 'react';

type ComposerSettings = Pick<IDialog, 'llm_id' | 'dataset_ids' | 'llm_setting'>;

export function useComposerSettings() {
  const { data: dialog, refetch } = useFetchChat();
  const { patchChat, loading } = usePatchChat();
  const [refreshing, setRefreshing] = useState(false);
  const pending = useRef(false);
  const canEdit = !!dialog.id && hasEditPermission(dialog.operator_permission);

  const saveSettings = useCallback(
    async (params: Partial<ComposerSettings>) => {
      if (!canEdit || loading || pending.current) return false;
      pending.current = true;
      setRefreshing(true);
      try {
        const code = await patchChat({ chatId: dialog.id, params });
        if (code !== 0) return false;
        const result = await refetch();
        return !result.isError;
      } catch {
        // The shared request layer displays the server's error.
        return false;
      } finally {
        pending.current = false;
        setRefreshing(false);
      }
    },
    [dialog.id, canEdit, loading, patchChat, refetch],
  );

  return { dialog, canEdit, saveSettings, saving: loading || refreshing };
}
