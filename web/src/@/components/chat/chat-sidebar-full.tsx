"use client";

import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/@/components/ui/sheet";
import { Button } from "~/@/components/ui/button";
import { MessageSquare, RotateCcw, ArrowLeft, Lock } from "lucide-react";
import { useChat } from "~/@/hooks/use-chat";
import { ChatInput } from "./chat-input";
import { ChatThread } from "./chat-thread";
import { ChatConversationList } from "./chat-conversation-list";
import { escapeClearsReading } from "./chat-reading-escape";
import { PremiumGate } from "~/@/components/premium/premium-gate";
import { useSubscription } from "~/@/hooks/use-subscription";
import { useSession } from "next-auth/react";

interface ChatSidebarFullProps {
  stockCode?: string;
  /** Open the sheet as soon as this mounts (the lazy shell swaps us in on the
   *  user's first click, so mounting == "the user just asked to open chat"). */
  initialOpen?: boolean;
}

/**
 * The real chat sidebar: Sheet + trigger + panel + the `useChat` state machine
 * (@ai-sdk/react + `ai` + connect-web, ~215KB raw). Never import this
 * statically from the layout — `chat-sidebar.tsx` is the lightweight shell
 * that lazy-loads it on first open. Once mounted it stays mounted, so chat
 * state survives sheet close/reopen exactly as before the split.
 */
export function ChatSidebarFull({ stockCode, initialOpen = false }: ChatSidebarFullProps) {
  const { data: session } = useSession();
  const userId = session?.user?.id;

  const {
    messages,
    status,
    isLoading,
    isLoadingHistory,
    error,
    historyError,
    conversationId,
    conversations,
    isLoadingConversations,
    sendMessage,
    retry,
    clearChat,
    stopGeneration,
    fetchConversations,
    loadConversation,
    deleteConversation,
  } = useChat({ contextStockCode: stockCode, userId });

  const { isPremium } = useSubscription();
  const [showHistory, setShowHistory] = useState(false);
  const [isOpen, setIsOpen] = useState(initialOpen);

  const showChat = Boolean(session && isPremium);

  // The list is for people who can chat. A free user who opens the sheet to see
  // the upgrade prompt must not spend a request on it, or log its refusal.
  useEffect(() => {
    if (isOpen && showChat) {
      void fetchConversations();
    }
  }, [isOpen, showChat, fetchConversations]);

  const handleLoadConversation = async (convId: string) => {
    await loadConversation(convId);
    setShowHistory(false);
  };

  const handleNewChat = () => {
    void clearChat();
    setShowHistory(false);
  };

  // Closing the panel mid-stream must abort the in-flight generation: the hook
  // lives in the persistent layout and does NOT unmount when the sheet closes,
  // so its own unmount-cleanup wouldn't fire here.
  const handleOpenChange = (open: boolean) => {
    if (!open && isLoading) stopGeneration();
    setIsOpen(open);
  };

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="fixed bottom-6 right-6 h-12 w-12 rounded-full shadow-lg z-50"
          aria-label={showChat ? "Open Shorted AI chat" : "Open AI chat upgrade prompt"}
        >
          <MessageSquare className="h-5 w-5" />
          {!showChat && (
            <Lock className="absolute -bottom-0.5 -right-0.5 h-4 w-4 text-muted-foreground bg-background rounded-full p-0.5" />
          )}
        </Button>
      </SheetTrigger>
      {/* max-w-full: the 400px floor overhangs a 375px phone by 25px, and the
          sheet is right-anchored, so the overhang clips off the LEFT edge and
          takes the back button and title with it. */}
      {/* Escape clears a chart's or sparkline's reading first; only a bare Escape closes the sheet. */}
      <SheetContent
        className="w-[400px] max-w-full sm:w-[450px] flex flex-col p-0"
        onEscapeKeyDown={(event) => {
          if (escapeClearsReading(event.target)) event.preventDefault();
        }}
      >
        {/* pr-12 reserves the corner for the sheet's own close button, which
            is absolutely positioned and otherwise lands on top of "New chat". */}
        <SheetHeader className="pl-4 pr-12 py-3 border-b flex-row items-center justify-between space-y-0">
          <SheetTitle className="text-base flex items-center gap-2">
            {showHistory && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setShowHistory(false)}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <MessageSquare className="h-4 w-4" />
            {showHistory ? "History" : "Shorted AI"}
          </SheetTitle>
          {showChat && !showHistory && (
            <div className="flex items-center gap-1">
              {userId && conversations.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowHistory(true)}
                  className="h-8 text-xs"
                >
                  History
                </Button>
              )}
              {messages.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleNewChat}
                  className="h-8 text-xs"
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  New chat
                </Button>
              )}
            </div>
          )}
        </SheetHeader>

        {showChat ? (
          showHistory ? (
            <ChatConversationList
              conversations={conversations}
              isLoading={isLoadingConversations}
              activeConversationId={conversationId}
              onSelect={handleLoadConversation}
              onDelete={deleteConversation}
              onNewChat={handleNewChat}
            />
          ) : (
            <>
              <ChatThread
                messages={messages}
                status={status}
                error={error}
                historyError={historyError}
                onRetry={() => void retry()}
                onNewChat={conversationId ? handleNewChat : undefined}
                onSuggest={(question) => void sendMessage(question)}
                loadingHistory={isLoadingHistory}
                stockCode={stockCode}
                variant="sheet"
              />

              <div className="border-t">
                <ChatInput
                  onSend={(message) => void sendMessage(message)}
                  onStop={stopGeneration}
                  status={status}
                  busy={isLoadingHistory}
                />
              </div>
            </>
          )
        ) : (
          <div className="flex-1 flex items-center justify-center p-6">
            <PremiumGate feature="AI Chat" variant="card">
              {/* This won't render — gate will show upgrade prompt */}
              <div />
            </PremiumGate>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
