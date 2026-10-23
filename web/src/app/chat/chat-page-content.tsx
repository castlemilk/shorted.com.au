"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useSubscription } from "~/@/hooks/use-subscription";
import { useChat } from "~/@/hooks/use-chat";
import { ChatInput } from "~/@/components/chat/chat-input";
import { ChatThread } from "~/@/components/chat/chat-thread";
import { ChatConversationList } from "~/@/components/chat/chat-conversation-list";
import { PremiumGate } from "~/@/components/premium/premium-gate";

export function ChatPageContent() {
  const { data: session } = useSession();
  const { isPremium } = useSubscription();
  const userId = session?.user?.id;

  const {
    messages,
    status,
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
  } = useChat({ userId });

  useEffect(() => {
    if (userId) {
      void fetchConversations();
    }
  }, [userId, fetchConversations]);

  const showChat = session && isPremium;

  if (!showChat) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <PremiumGate feature="AI Chat" variant="card">
          <div />
        </PremiumGate>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] max-w-7xl mx-auto">
      {/* Left panel — conversation list */}
      <div className="hidden md:flex w-72 lg:w-80 border-r flex-col">
        <ChatConversationList
          conversations={conversations}
          isLoading={isLoadingConversations}
          activeConversationId={conversationId}
          onSelect={(id) => void loadConversation(id)}
          onDelete={(id) => void deleteConversation(id)}
          onNewChat={clearChat}
        />
      </div>

      {/* Right panel — chat */}
      <div className="flex-1 flex flex-col min-w-0">
        <ChatThread
          messages={messages}
          status={status}
          error={error}
          historyError={historyError}
          onRetry={() => void retry()}
          onSuggest={(question) => void sendMessage(question)}
          variant="page"
        />

        <div className="border-t">
          <div className="max-w-3xl mx-auto">
            <ChatInput
              onSend={(message) => void sendMessage(message)}
              onStop={stopGeneration}
              status={status}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
