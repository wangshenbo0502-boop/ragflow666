import { NextMessageInput } from '@/components/message-input/next';
import MessageItem from '@/components/message-item';
import PdfSheet from '@/components/pdf-drawer';
import { useClickDrawer } from '@/components/pdf-drawer/hooks';
import { VirtualMessageList } from '@/components/virtual-message-list';
import { MessageType } from '@/constants/chat';
import { useGetChatSearchParams } from '@/hooks/use-chat-request';
import { useFetchUserInfo } from '@/hooks/use-user-setting-request';
import { IClientConversation } from '@/interfaces/database/chat';
import { useEffect } from 'react';
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

interface IProps {
  conversation: IClientConversation;
}

export function SingleChatBox({ conversation }: IProps) {
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
  } = useSendMessage();
  const { data: userInfo } = useFetchUserInfo();
  const {
    dialog: currentDialog,
    canEdit,
    saveSettings,
    saving,
  } = useComposerSettings();
  const { conversationId } = useGetChatSearchParams();
  const disabled = useGetSendButtonDisabled();
  const sendDisabled = useSendButtonDisabled(value, hasAttachments);
  const { visible, hideModal, documentId, selectedChunk, clickDocumentButton } =
    useClickDrawer();

  const showInternet = useShowInternet();

  const messageReferences = useMessageReferences(messages);

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
      // hydrateFromServer is a no-op while a stream is in flight, and rejects a
      // server list shorter than the local one, so it can never truncate an
      // answer the server hasn't persisted yet.
      hydrateFromServer(conversationId, messages);
    }
  }, [
    conversation?.messages,
    conversation?.id,
    conversationId,
    hydrateFromServer,
  ]);

  return (
    <section className="flex flex-col h-full gap-4">
      <div
        ref={messageContainerRef}
        className="p-5 flex-1 overflow-auto min-h-0 scrollbar-auto"
      >
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
      </div>

      <div className="p-5 pt-0">
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
