import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { MessageType } from '@/constants/chat';
import { SingleChatBox } from './single-chat-box';

const mockHydrateFromServer = jest.fn();
const mockUseGetChatSearchParams = jest.fn();
const mockUseChatTaskRecovery = jest.fn<
  { active: never[]; error: undefined },
  [chatId: string, sessionId: string]
>(() => ({
  active: [],
  error: undefined,
}));

jest.mock('@/components/message-input/next', () => ({
  NextMessageInput: ({
    advancedActions,
  }: {
    advancedActions: React.ReactNode;
  }) => {
    const React = require('react');
    const [open, setOpen] = React.useState(false);
    function toggle() {
      setOpen(!open);
    }
    return (
      <>
        <button onClick={toggle}>Advanced options</button>
        {open && <div role="dialog">{advancedActions}</div>}
      </>
    );
  },
}));
jest.mock('@/components/message-item', () => () => null);
jest.mock('./composer-model-select', () => ({
  ComposerModelSelect: () => <button>Conversation model</button>,
}));
jest.mock('./composer-dataset-select', () => ({
  ComposerDatasetSelect: () => <button>Knowledge bases</button>,
}));
jest.mock('./chat-route-policy', () => ({
  ChatRoutePolicy: () => null,
}));
jest.mock('./chat-task-center', () => ({
  ChatTaskCenter: () => null,
}));
jest.mock('../../hooks/use-chat-task-recovery', () => ({
  useChatTaskRecovery: (chatId: string, sessionId: string) =>
    mockUseChatTaskRecovery(chatId, sessionId),
}));
jest.mock('./use-composer-settings', () => ({
  useComposerSettings: () => ({
    dialog: { icon: '' },
    canEdit: true,
    saving: false,
    saveSettings: jest.fn(),
  }),
}));
jest.mock('@/components/virtual-message-list', () => ({
  VirtualMessageList: () => null,
}));
jest.mock('@/components/pdf-drawer', () => () => null);
jest.mock('@/components/pdf-drawer/hooks', () => ({
  useClickDrawer: () => ({
    visible: false,
    hideModal: jest.fn(),
    documentId: '',
    selectedChunk: undefined,
    clickDocumentButton: jest.fn(),
  }),
}));
jest.mock('@/hooks/use-chat-request', () => ({
  useFetchChat: () => ({ data: { icon: '' } }),
  useGetChatSearchParams: () => mockUseGetChatSearchParams(),
}));
jest.mock('@/hooks/use-user-setting-request', () => ({
  useFetchUserInfo: () => ({ data: { nickname: '', avatar: '' } }),
}));
jest.mock('@/utils/chat', () => ({
  buildMessageUuidWithRole: () => 'message-key',
}));
jest.mock('../../hooks/use-button-disabled', () => ({
  useGetSendButtonDisabled: () => false,
  useSendButtonDisabled: () => false,
}));
jest.mock('../../hooks/use-create-conversation', () => ({
  useCreateConversationBeforeUploadDocument: () => ({
    createConversationBeforeUploadDocument: jest.fn(),
  }),
}));
jest.mock('../../hooks/use-send-chat-message', () => ({
  useSendMessage: () => ({
    value: '',
    scrollRef: { current: null },
    messageContainerRef: { current: null },
    sendLoading: false,
    messages: [],
    isUploading: false,
    handleInputChange: jest.fn(),
    handlePressEnter: jest.fn(),
    regenerateMessage: jest.fn(),
    removeMessageById: jest.fn(),
    handleUploadFile: jest.fn(),
    removeFile: jest.fn(),
    hydrateFromServer: mockHydrateFromServer,
    stopOutputMessage: jest.fn(),
  }),
}));
jest.mock('../../utils', () => ({
  buildMessageItemReference: () => undefined,
}));
jest.mock('../use-show-internet', () => ({
  useShowInternet: () => false,
}));

function buildConversation(id: string) {
  return {
    id,
    chat_id: 'chat-id',
    name: 'Conversation',
    avatar: '',
    create_date: '',
    create_time: 0,
    update_date: '',
    update_time: 0,
    is_new: true as const,
    messages: [
      {
        id: 'old-message',
        role: MessageType.User,
        content: 'Old conversation message',
      },
    ],
  };
}

describe('SingleChatBox conversation hydration', () => {
  beforeEach(() => {
    mockHydrateFromServer.mockClear();
    mockUseGetChatSearchParams.mockReset();
    mockUseChatTaskRecovery.mockClear();
  });

  it('puts the model and knowledge base selectors in advanced options', () => {
    const conversation = buildConversation('current-conversation');
    mockUseGetChatSearchParams.mockReturnValue({
      conversationId: conversation.id,
    });
    render(<SingleChatBox conversation={conversation} />, {
      wrapper: MemoryRouter,
    });

    expect(
      screen.queryByRole('button', { name: 'Conversation model' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Knowledge bases' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }));

    const panel = within(screen.getByRole('dialog'));
    expect(
      panel.getByRole('button', { name: 'Conversation model' }),
    ).toBeInTheDocument();
    expect(
      panel.getByRole('button', { name: 'Knowledge bases' }),
    ).toBeInTheDocument();
  });

  it('ignores stale messages while the URL points to a new conversation', () => {
    mockUseGetChatSearchParams.mockReturnValue({
      conversationId: 'new-conversation',
    });

    render(
      <SingleChatBox conversation={buildConversation('old-conversation')} />,
      { wrapper: MemoryRouter },
    );

    expect(mockHydrateFromServer).not.toHaveBeenCalled();
  });

  it('only starts task recovery after the draft gets a saved session ID', () => {
    mockUseGetChatSearchParams.mockReturnValue({
      conversationId: 'draft-conversation',
      isNew: 'true',
    });
    const conversation = buildConversation('saved-conversation');
    const { rerender } = render(<SingleChatBox conversation={conversation} />, {
      wrapper: MemoryRouter,
    });

    expect(mockUseChatTaskRecovery).toHaveBeenLastCalledWith(
      expect.any(String),
      '',
    );

    mockUseGetChatSearchParams.mockReturnValue({
      conversationId: conversation.id,
      isNew: '',
    });
    rerender(<SingleChatBox conversation={conversation} />);

    expect(mockUseChatTaskRecovery).toHaveBeenLastCalledWith(
      expect.any(String),
      conversation.id,
    );
  });

  it('hydrates messages when the conversation matches the URL', async () => {
    const conversation = buildConversation('current-conversation');
    mockUseGetChatSearchParams.mockReturnValue({
      conversationId: conversation.id,
    });

    render(<SingleChatBox conversation={conversation} />, {
      wrapper: MemoryRouter,
    });

    await waitFor(() => {
      expect(mockHydrateFromServer).toHaveBeenCalledWith(
        conversation.id,
        conversation.messages,
        conversation.update_time,
      );
    });
  });

  it('hydrates a newer server version even when the messages array is unchanged', async () => {
    const conversation = buildConversation('current-conversation');
    mockUseGetChatSearchParams.mockReturnValue({
      conversationId: conversation.id,
    });
    const { rerender } = render(<SingleChatBox conversation={conversation} />, {
      wrapper: MemoryRouter,
    });
    await waitFor(() => {
      expect(mockHydrateFromServer).toHaveBeenCalledTimes(1);
      expect(mockHydrateFromServer).toHaveBeenLastCalledWith(
        conversation.id,
        conversation.messages,
        conversation.update_time,
      );
    });

    const updated = { ...conversation, update_time: 1 };
    rerender(<SingleChatBox conversation={updated} />);

    await waitFor(() => {
      expect(mockHydrateFromServer).toHaveBeenCalledTimes(2);
      expect(mockHydrateFromServer).toHaveBeenLastCalledWith(
        updated.id,
        conversation.messages,
        updated.update_time,
      );
    });
  });
});
