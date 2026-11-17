import { NextMessageInput } from '@/components/message-input/next';
import MessageItem from '@/components/message-item';
import PdfSheet from '@/components/pdf-drawer';
import { useClickDrawer } from '@/components/pdf-drawer/hooks';
import { VirtualMessageList } from '@/components/virtual-message-list';
import { MessageType } from '@/constants/chat';
import { useGetChatSearchParams } from '@/hooks/use-chat-request';
import { useFetchUserInfo } from '@/hooks/use-user-setting-request';
import {
  ChatMediaAsset,
  IClientConversation,
} from '@/interfaces/database/chat';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatMediaContext } from '@/components/chat-media-image';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router';
import {
  useGetSendButtonDisabled,
  useSendButtonDisabled,
} from '../../hooks/use-button-disabled';
import { useSendMessage } from '../../hooks/use-send-chat-message';
import { useMessageReferences } from '../../hooks/use-message-references';
import { EmptyReference } from '../../utils';
import { useShowInternet } from '../use-show-internet';
import { ComposerDatasetSelect } from './composer-dataset-select';
import { ComposerModelSelect } from './composer-model-select';
import { useComposerSettings } from './use-composer-settings';
import {
  ChatMediaMode,
  ChatMediaModes,
  ChatRoutePolicy,
} from './chat-media-modes';
import { ChatTaskCenter } from './chat-task-center';
import { useChatTaskRecovery } from '../../hooks/use-chat-task-recovery';
import { ChatTaskStages, ChatTaskStates } from '../../constant/chat-tasks';

interface IProps {
  conversation: IClientConversation;
}

export function SingleChatBox({ conversation }: IProps) {
  const [mode, setMode] = useState<ChatMediaMode>('chat');
  const [routePolicy, setRoutePolicy] = useState('fixed');
  const [editAsset, setEditAsset] = useState<ChatMediaAsset>();
  const { id: chatId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const {
    value,
    virtualizer,
    messageContainerRef,
    sendLoading,
    messages,
    isUploading,
    hasAttachments,
    handleInputChange,
    handlePressEnter,
    regenerateMessage,
    removeMessageById,
    handleUploadFile,
    removeFile,
    hydrateFromServer,
    stopOutputMessage,
  } = useSendMessage(mode, routePolicy, editAsset?.id);
  const { data: userInfo } = useFetchUserInfo();
  const {
    dialog: currentDialog,
    canEdit,
    saveSettings,
    saving,
  } = useComposerSettings();
  const { conversationId } = useGetChatSearchParams();
  useEffect(() => {
    setEditAsset(undefined);
  }, [conversationId]);
  const handleEditImage = useCallback((asset: ChatMediaAsset) => {
    setMode('image');
    setEditAsset(asset);
  }, []);
  const handleClearEdit = useCallback(() => {
    setEditAsset(undefined);
  }, []);
  const handleViewImage = useCallback(
    (asset: ChatMediaAsset) => {
      const index = messages.findIndex((message) =>
        message.media_assets?.some((item) => item.id === asset.id),
      );
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
    },
    [messages, virtualizer],
  );
  const mediaContext = useMemo(
    () => ({
      assets: messages.flatMap((message) => message.media_assets ?? []),
      onEdit: handleEditImage,
      onView: handleViewImage,
    }),
    [messages, handleEditImage, handleViewImage],
  );
  const recovery = useChatTaskRecovery(chatId, conversationId);
  const disabled = useGetSendButtonDisabled();
  const sendDisabled = useSendButtonDisabled(value, hasAttachments);
  const { visible, hideModal, documentId, selectedChunk, clickDocumentButton } =
    useClickDrawer();

  const showInternet = useShowInternet();

  const messageReferences = useMessageReferences(messages);
  const jumpTurn = searchParams.get('turn');
  useEffect(() => {
    if (!jumpTurn) return;
    const index = messages.findIndex((message) => message.id === jumpTurn);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
  }, [jumpTurn, messages, virtualizer]);

  useEffect(() => {
    // Skip when the conversation prop is stale — its id doesn't match the
    // URL's current conversationId. This happens during a switch (e.g.
    // clicking "+" to create a new session): child effects fire before the
    // parent's clear/load effect, so for one render the prop still holds the
    // previous conversation's messages. Applying them here would leak the old
    // conversation's content into the newly switched (or new) conversation.
    if (conversation?.id && conversation.id !== conversationId) return;

    const messages = conversation?.messages;
    if (Array.isArray(messages)) {
      // Active streams own their local output; idle sessions follow the server.
      hydrateFromServer(conversationId, messages, conversation.update_time);
    }
  }, [
    conversation?.messages,
    conversation?.id,
    conversation?.update_time,
    conversationId,
    hydrateFromServer,
  ]);

  return (
    <section className="flex flex-col h-full gap-4">
      <div
        ref={messageContainerRef}
        className="p-5 flex-1 overflow-auto min-h-0 scrollbar-auto"
      >
        <ChatMediaContext.Provider value={mediaContext}>
          <VirtualMessageList
            className="w-full pr-5"
            items={messages ?? []}
            virtualizer={virtualizer}
            renderItem={(message, i) => (
              <MessageItem
                loading={
                  message.role === MessageType.Assistant &&
                  sendLoading &&
                  (messages?.length ?? 0) - 1 === i
                }
                nickname={userInfo.nickname}
                avatar={userInfo.avatar}
                avatarDialog={currentDialog.icon}
                item={message}
                reference={messageReferences.get(message) ?? EmptyReference}
                clickDocumentButton={clickDocumentButton}
                index={i}
                isLast={(messages?.length ?? 0) - 1 === i}
                removeMessageById={removeMessageById}
                deleteDisabled={sendLoading}
                regenerateMessage={regenerateMessage}
                sendLoading={sendLoading}
              />
            )}
          />
        </ChatMediaContext.Provider>
      </div>

      <div className="p-5 pt-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <ChatMediaModes
            mode={mode}
            onModeChange={setMode}
            disabled={sendLoading}
          />
          <div className="flex items-center gap-2">
            <ChatRoutePolicy
              value={routePolicy}
              onChange={setRoutePolicy}
              disabled={sendLoading}
            />
            <ChatTaskCenter />
          </div>
        </div>
        {recovery.active.map((task) => (
          <p
            key={task.id}
            role="status"
            className="mb-2 break-words text-sm text-text-secondary"
          >
            {ChatTaskStates[task.state]} ·{' '}
            {ChatTaskStages[task.stage] ?? task.stage}
          </p>
        ))}
        {recovery.error && (
          <p role="alert" className="mb-2 break-words text-sm text-state-error">
            {recovery.error.message}
          </p>
        )}
        {editAsset && (
          <div className="mb-2 flex min-w-0 items-center gap-2 text-sm text-text-secondary">
            <span className="break-all">
              编辑图片 {editAsset.id.slice(0, 8)} · {editAsset.width} ×{' '}
              {editAsset.height}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleClearEdit}
              title="取消编辑目标"
              aria-label="取消编辑目标"
            >
              <X size={16} />
            </Button>
          </div>
        )}
        <NextMessageInput
          mediaCommands
          disabled={disabled || saving}
          sendDisabled={sendDisabled || saving}
          sendLoading={sendLoading}
          value={value}
          resize="vertical"
          onInputChange={handleInputChange}
          onPressEnter={handlePressEnter}
          conversationId={conversationId}
          stopOutputMessage={stopOutputMessage}
          onUpload={handleUploadFile}
          isUploading={isUploading}
          removeFile={removeFile}
          showReasoning
          showInternet={showInternet}
          leadingActions={
            <ComposerDatasetSelect
              dialog={currentDialog}
              saving={saving}
              disabled={disabled || sendLoading || !canEdit}
              saveSettings={saveSettings}
            />
          }
          trailingActions={
            <ComposerModelSelect
              dialog={currentDialog}
              saving={saving}
              disabled={disabled || sendLoading || !canEdit}
              saveSettings={saveSettings}
            />
          }
        />
        {visible && (
          <PdfSheet
            visible={visible}
            hideModal={hideModal}
            documentId={documentId}
            chunk={selectedChunk}
          ></PdfSheet>
        )}
      </div>
    </section>
  );
}
