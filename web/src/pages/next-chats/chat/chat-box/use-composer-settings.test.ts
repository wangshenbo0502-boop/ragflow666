import { act, renderHook } from '@testing-library/react';
import { useComposerSettings } from './use-composer-settings';

const mockPatchChat = jest.fn();
const mockRefetch = jest.fn();
const mockCanEdit = jest.fn();

jest.mock('@/ee/utils/permission-util', () => ({
  hasEditPermission: () => mockCanEdit(),
}));
jest.mock('@/hooks/use-chat-request', () => ({
  useFetchChat: () => ({
    data: { id: 'chat-1', llm_id: 'original-model', dataset_ids: ['kb-1'] },
    refetch: mockRefetch,
  }),
  usePatchChat: () => ({ patchChat: mockPatchChat, loading: false }),
}));

describe('composer settings persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanEdit.mockReturnValue(true);
    mockPatchChat.mockResolvedValue(0);
    mockRefetch.mockResolvedValue({ isError: false });
  });

  it('persists the model before refreshing the chat used for completion', async () => {
    const { result } = renderHook(useComposerSettings);
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.saveSettings({ llm_id: 'model-2' });
    });
    expect(saved).toBe(true);
    expect(mockPatchChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      params: { llm_id: 'model-2' },
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockPatchChat.mock.invocationCallOrder[0]).toBeLessThan(
      mockRefetch.mock.invocationCallOrder[0],
    );
  });

  it('does not replace the visible selection when saving fails', async () => {
    mockPatchChat.mockResolvedValue(102);
    const { result } = renderHook(useComposerSettings);
    await act(async () => {
      expect(await result.current.saveSettings({ llm_id: 'model-2' })).toBe(
        false,
      );
    });
    expect(result.current.dialog.llm_id).toBe('original-model');
    expect(mockRefetch).not.toHaveBeenCalled();
    expect(result.current.saving).toBe(false);
  });

  it('blocks overlapping saves until the refreshed settings arrive', async () => {
    let finishRefresh!: (value: { isError: boolean }) => void;
    mockRefetch.mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    const { result } = renderHook(useComposerSettings);
    let firstSave!: Promise<boolean>;
    await act(async () => {
      firstSave = result.current.saveSettings({ dataset_ids: ['kb-2'] });
      expect(await result.current.saveSettings({ dataset_ids: [] })).toBe(
        false,
      );
    });
    expect(result.current.saving).toBe(true);
    expect(mockPatchChat).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishRefresh({ isError: false });
      expect(await firstSave).toBe(true);
    });
    expect(result.current.saving).toBe(false);
  });

  it('allows clearing knowledge bases without modifying the model', async () => {
    const { result } = renderHook(useComposerSettings);
    await act(async () => {
      await result.current.saveSettings({ dataset_ids: [] });
    });
    expect(mockPatchChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      params: { dataset_ids: [] },
    });
  });

  it('rejects changes without edit permission', async () => {
    mockCanEdit.mockReturnValue(false);
    const { result } = renderHook(useComposerSettings);
    await act(async () => {
      expect(await result.current.saveSettings({ dataset_ids: [] })).toBe(
        false,
      );
    });
    expect(mockPatchChat).not.toHaveBeenCalled();
  });

  it('unlocks after a network error', async () => {
    mockPatchChat.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(useComposerSettings);
    await act(async () => {
      expect(await result.current.saveSettings({ llm_id: 'model-2' })).toBe(
        false,
      );
    });
    expect(result.current.saving).toBe(false);
  });
});
