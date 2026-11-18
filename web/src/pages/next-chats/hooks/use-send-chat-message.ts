import { NextMessageInputOnPressEnterParameter } from '@/components/message-input/next';
import { MessageType } from '@/constants/chat';
import { useHandleMessageInputChange } from '@/hooks/logic-hooks';
import { useFetchChat, useGetChatSearchParams } from '@/hooks/use-chat-request';
import { useRefreshChatTasks } from '@/hooks/use-chat-task-request';
import { useVirtualMessages } from '@/hooks/use-virtual-messages';
import { buildMessageListWithUuid } from '@/utils/chat';
import { IMessage, Message } from '@/interfaces/database/chat';
import notification from '@/utils/notification';
import { trim } from 'lodash';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router';
import { v4 as uuid } from 'uuid';
import { runChatCompletionStream } from '../chat-stream/run-stream';
import {
  useChatPendingInput,
  useChatStreamMessages,
  useChatStreamStore,
  useIsChatStreaming,
} from '../chat-stream/store';
import { resolveResendOptions } from '../utils';
import { useCreateConversationBeforeSendMessage } from './use-chat-url';
import { useFindPrologueFromDialogList } from './use-select-conversation-list';
import { useUploadFile } from './use-upload-file';
import type { ChatMediaMode } from '../chat/chat-box/chat-media-modes';

/**
 * Subscribes to the current conversation's entry in the chat stream store and
 * seeds the prologue for a brand new session. Because the store lives at module
 * level, an in-flight stream keeps updating it while this page is unmounted, so
 * switching back re-attaches to the still-running stream.
 */
export const useCurrentChatSession = () => {
  const { conversationId, isNew } = useGetChatSearchParams();
  const { id: dialogId } = useParams();
  const prologue = useFindPrologueFromDialogList();

  const messages = useChatStreamMessages(conversationId);
  const isStreaming = useIsChatStreaming(conversationId);

  const messageContainerRef = useRef<HTMLDivElement>(null);
  const { virtualizer, scrollToBottom } = useVirtualMessages(
    messages,
    messageContainerRef,
    { resetKey: conversationId },
  );

  const ensureSession = useChatStreamStore((state) => state.ensureSession);
  const seedPrologue = useChatStreamStore((state) => state.seedPrologue);

  useEffect(() => {
    if (!conversationId) return;
    ensureSession(conversationId, dialogId ?? '');
  }, [conversationId, dialogId, ensureSession]);

  useEffect(() => {
    if (!conversationId || isNew !== 'true') return;
    seedPrologue(conversationId, dialogId ?? '', prologue ?? '');
  }, [conversationId, dialogId, isNew, prologue, seedPrologue]);

  return {
    messages,
    isStreaming,
    virtualizer,
    messageContainerRef,
    scrollToBottom,
  };
};

export const useSendMessage = (
  mode: ChatMediaMode = 'chat',
  routePolicy = 'fixed',
  editAssetId?: string,
) => {
  const { conversationId } = useGetChatSearchParams();
  const { t } = useTranslation();
  const { handleInputChange, value, setValue } = useHandleMessageInputChange();
  const location = useLocation();
  const valueRef = useRef(value);
  valueRef.current = value;
  const sendingRef = useRef(false);
  const navigate = useNavigate();
  useEffect(() => {
    const question = location.state?.railwayQuestion;
    if (typeof question !== 'string') return;
    setValue(question);
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: null,
    });
  }, [location.state, location.pathname, location.search, navigate, setValue]);

  const { handleUploadFile, isUploading, removeFile, files, clearFiles } =
    useUploadFile();

  const { id: chatId } = useParams();
  const { data: currentDialog } = useFetchChat();
  const refreshTasks = useRefreshChatTasks();
  const {
    messages,
    isStreaming,
    virtualizer,
    messageContainerRef,
    scrollToBottom,
  } = useCurrentChatSession();

  const appendQuestion = useChatStreamStore((state) => state.appendQuestion);
  const failStream = useChatStreamStore((state) => state.failStream);
  const consumePendingInput = useChatStreamStore(
    (state) => state.consumePendingInput,
  );
  const pendingInput = useChatPendingInput(conversationId);
  const removeMessageFromStore = useChatStreamStore(
    (state) => state.removeMessageById,
  );
  const hydrateFromServer = useChatStreamStore(
    (state) => state.hydrateFromServer,
  );
  const stopStream = useChatStreamStore((state) => state.stopStream);

  // The regenerate button lives in the transcript, which has no access to the
  // input box's thinking / internet toggles. Remember what the last send used
  // so a retry keeps the same options instead of silently dropping them.
  const lastSendOptionsRef = useRef<NextMessageInputOnPressEnterParameter>({});

  const sendMessage = useCallback(
    async ({
      message,
      currentConversationId,
      enableInternet,
      enableThinking,
    }: {
      message: IMessage;
      currentConversationId?: string;
    } & NextMessageInputOnPressEnterParameter) => {
      const sessionId = currentConversationId ?? conversationId;

      lastSendOptionsRef.current = { enableInternet, enableThinking };

      const { ok, aborted, accepted, error } = await runChatCompletionStream({
        messageId: message.id,
        conversationId: sessionId,
        chatId,
        question: message.content,
        files: message.files,
        enableThinking,
        enableInternet,
        llmSetting: currentDialog?.llm_setting,
        mode,
        routePolicy,
        editAssetId,
        onTaskUpdate: refreshTasks,
      });

      if (!ok && !aborted && !accepted) {
        // The failure can land long after the page unmounted or after the user
        // switched conversations, so don't write to the input box here: park the
        // text on the failing session instead, and tell the user something went
        // wrong wherever they currently are.
        failStream(sessionId, message.content);
        notification.error({
          message: t('message.requestError'),
          description: error,
        });
      }
    },
    [
      conversationId,
      chatId,
      failStream,
      t,
      currentDialog?.llm_setting,
      mode,
      routePolicy,
      editAssetId,
      refreshTasks,
    ],
  );

  // Hand a failed question back to the input box, but only once the box is
  // empty so a message the user is currently typing is never clobbered.
  useEffect(() => {
    if (!pendingInput || trim(value) !== '') return;
    consumePendingInput(conversationId);
    setValue(pendingInput);
  }, [pendingInput, value, conversationId, consumePendingInput, setValue]);

  const removeMessageById = useCallback(
    (messageId: string) => {
      removeMessageFromStore(conversationId, messageId);
    },
    [conversationId, removeMessageFromStore],
  );

  // Regenerating re-asks the same question as a new turn instead of rewriting
  // the original exchange, so every earlier answer stays in the transcript.
  const regenerateMessage = useCallback(
    (message: Message) => {
      if (isStreaming) return;

      const questionMessage: IMessage = {
        content: message.content,
        files: message.files,
        id: uuid(),
        role: MessageType.User,
        conversationId,
      };

      appendQuestion(conversationId, questionMessage);
      sendMessage({
        message: questionMessage,
        ...resolveResendOptions(lastSendOptionsRef.current),
      });
    },
    [conversationId, isStreaming, appendQuestion, sendMessage],
  );

  const { createConversationBeforeSendMessage } =
    useCreateConversationBeforeSendMessage();

  const handlePressEnter = useCallback(
    async ({
      enableThinking,
      enableInternet,
    }: NextMessageInputOnPressEnterParameter) => {
      if (
        (trim(value) === '' && files.length === 0) ||
        isStreaming ||
        isUploading ||
        sendingRef.current
      )
        return false;
      const question = trim(value) || t('chat.attachmentQuestion');

      sendingRef.current = true;
      let data;
      try {
        data = await createConversationBeforeSendMessage(question);
      } finally {
        sendingRef.current = false;
      }

      if (data === undefined) {
        return false;
      }

      const { targetConversationId, currentMessages, sourceStillCurrent } =
        data;

      // The await above can span a conversation switch, and the target session
      // may already have a stream running.
      if (
        useChatStreamStore.getState().sessions[targetConversationId]
          ?.isStreaming
      ) {
        return false;
      }

      const id = uuid();

      const questionMessage: IMessage = {
        content: question,
        files,
        id,
        role: MessageType.User,
        conversationId: targetConversationId,
      };

      // A brand new conversation is persisted under a server-generated id, so
      // the prologue seeded on the temporary id doesn't carry over. Seed the
      // real session from the server's list (which holds just the prologue)
      // BEFORE appending the question — hydrating afterwards would pass the
      // authority check (not streaming yet) and wipe the question and
      // placeholder that were just appended.
      if (currentMessages.length > 0) {
        hydrateFromServer(
          targetConversationId,
          buildMessageListWithUuid(currentMessages),
        );
      }

      // Route the question to the conversation it was asked in, not whichever
      // is currently displayed.
      appendQuestion(targetConversationId, questionMessage);

      if (sourceStillCurrent && valueRef.current === value) setValue('');
      sendMessage({
        currentConversationId: targetConversationId,
        message: {
          id,
          content: question,
          role: MessageType.User,
          files,
          conversationId: targetConversationId,
        },
        enableInternet,
        enableThinking,
      });

      if (sourceStillCurrent) clearFiles();

      // Auto scroll to bottom when sending new message
      if (sourceStillCurrent) requestAnimationFrame(scrollToBottom);
      return true;
    },
    [
      value,
      isStreaming,
      isUploading,
      t,
      createConversationBeforeSendMessage,
      appendQuestion,
      hydrateFromServer,
      files,
      clearFiles,
      setValue,
      sendMessage,
      scrollToBottom,
    ],
  );

  const stopOutputMessage = useCallback(() => {
    stopStream(conversationId);
  }, [conversationId, stopStream]);

  return {
    handlePressEnter,
    handleInputChange,
    value,
    setValue,
    regenerateMessage,
    sendLoading: isStreaming,
    virtualizer,
    messageContainerRef,
    messages,
    removeMessageById,
    handleUploadFile,
    isUploading,
    hasAttachments: files.length > 0,
    removeFile,
    hydrateFromServer,
    stopOutputMessage,
  };
};
