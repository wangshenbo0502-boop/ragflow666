import {
  useFetchSessionList,
  useFetchSessionManually,
  useGetChatSearchParams,
} from '@/hooks/use-chat-request';
import { IClientConversation } from '@/interfaces/database/chat';
import { useIsMobile } from '@/components/hooks/use-mobile';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { MessagesSquare } from 'lucide-react';
import { RootLayoutContainer } from '@/layouts/root-layout';
import { isEmpty } from 'lodash';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHandleClickConversationCard } from '../hooks/use-click-card';
import { ChatSettings } from './app-settings/chat-settings';
import { SingleChatBox } from './chat-box/single-chat-box';
import { Sessions } from './sessions';

export default function Chat() {
  const { t } = useTranslation();
  const [currentConversation, setCurrentConversation] =
    useState<IClientConversation>({} as IClientConversation);
  const isMobile = useIsMobile();
  const [sessionsOpen, setSessionsOpen] = useState(false);

  const { fetchSessionManually } = useFetchSessionManually();

  const { handleConversationCardClick } = useHandleClickConversationCard();
  const handleMobileConversation = (id: string, isNew: boolean) => {
    handleConversationCardClick(id, isNew);
    setSessionsOpen(false);
  };
  const closeSessions = () => setSessionsOpen(false);
  const handleSessionsKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeSessions();
    }
  };

  const { conversationId, isNew } = useGetChatSearchParams();
  useEffect(() => {
    setSessionsOpen(false);
  }, [conversationId]);

  const { data: dialogList } = useFetchSessionList();

  const currentConversationName = useMemo(() => {
    return (
      dialogList.find((x) => x.id === conversationId)?.name ||
      t('chat.newConversation')
    );
  }, [conversationId, dialogList, t]);

  // The URL is the single source of truth for which conversation is open:
  // card clicks, "+" and the temp→real id swap after the first send all land
  // here. Clear first so the previous conversation's messages and references
  // can never leak into the newly opened one while the fetch is in flight.
  useEffect(() => {
    setCurrentConversation((previous) =>
      isEmpty(previous) ? previous : ({} as IClientConversation),
    );
    if (!conversationId || isNew === 'true') return;

    let cancelled = false;
    fetchSessionManually(conversationId).then((conversation) => {
      if (!cancelled && !isEmpty(conversation)) {
        setCurrentConversation(conversation);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, isNew, fetchSessionManually]);

  return (
    <RootLayoutContainer>
      <section className="h-full flex flex-col" data-testid="chat-detail">
        <article className="relative flex flex-1 min-h-0 pb-3 md:pb-9">
          {!isMobile && (
            <Sessions
              handleConversationCardClick={handleConversationCardClick}
            />
          )}

          <div className="flex flex-1 min-w-0 h-full">
            <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
              <header className="flex min-w-0 items-center gap-3 border-b border-border-button p-3 md:p-5">
                {isMobile && (
                  <Sheet open={sessionsOpen} onOpenChange={setSessionsOpen}>
                    <SheetTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('chat.conversations')}
                        title={t('chat.conversations')}
                      >
                        <MessagesSquare className="size-4" />
                      </Button>
                    </SheetTrigger>
                    <SheetContent
                      side="left"
                      className="flex w-[min(340px,90vw)] flex-col p-0"
                      closeIcon={false}
                      onKeyDown={handleSessionsKeyDown}
                    >
                      <SheetTitle className="sr-only">
                        {t('chat.conversations')}
                      </SheetTitle>
                      <Sessions
                        handleConversationCardClick={handleMobileConversation}
                        onClose={closeSessions}
                      />
                    </SheetContent>
                  </Sheet>
                )}
                <h1 className="min-w-0 truncate text-base font-medium">
                  {currentConversationName}
                </h1>
              </header>
              <div className="flex-1 min-h-0">
                <SingleChatBox conversation={currentConversation} />
              </div>
            </div>

            <ChatSettings hasSingleChatBox />
          </div>
        </article>
      </section>
    </RootLayoutContainer>
  );
}
