"use client";

import { useRef, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useSubscription } from "~/@/hooks/use-subscription";
import { useChat } from "~/@/hooks/use-chat";
import { ChatMessageBubble } from "~/@/components/chat/chat-message";
import { ChatInput } from "~/@/components/chat/chat-input";
import { QuickActions } from "~/@/components/chat/quick-actions";
import { ChatConversationList } from "~/@/components/chat/chat-conversation-list";
import { PremiumGate } from "~/@/components/premium/premium-gate";
import { MessageSquare, Loader2 } from "lucide-react";

export function ChatPageContent() {
  const { data: session } = useSession();
  const { isPremium } = useSubscription();
  const userId = session?.user?.id;

  const {
    messages,
    isLoading,
    error,
    conversationId,
    conversations,
    isLoadingConversations,
    sendMessage,
    clearChat,
    stopGeneration,
    fetchConversations,
    loadConversation,
    deleteConversation,
  } = useChat({ userId });

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

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
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center max-w-md mx-auto">
              <MessageSquare className="h-10 w-10 text-muted-foreground mb-4" />
              <h2 className="text-lg font-semibold">Ask Shorted AI</h2>
              <p className="text-sm text-muted-foreground mt-1 mb-6">
                Get insights about short positions, stocks, director trades,
                peer comparisons, and market trends.
              </p>
              <QuickActions onSelect={sendMessage} />
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <ChatMessageBubble key={msg.id} message={msg} />
              ))}
              {isLoading && !messages.some((m) => m.isStreaming) && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Thinking...
                </div>
              )}
              {error && (
                <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t">
          <div className="max-w-3xl mx-auto">
            <ChatInput
              onSend={sendMessage}
              onStop={stopGeneration}
              isLoading={isLoading}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
