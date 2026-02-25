"use client";

import { useRef, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/@/components/ui/sheet";
import { Button } from "~/@/components/ui/button";
import { MessageSquare, RotateCcw, Loader2 } from "lucide-react";
import { useChat } from "~/@/hooks/use-chat";
import { ChatMessageBubble } from "./chat-message";
import { ChatInput } from "./chat-input";
import { QuickActions } from "./quick-actions";
import { PremiumGate } from "~/@/components/premium/premium-gate";
import { useSubscription } from "~/@/hooks/use-subscription";
import { useSession } from "next-auth/react";

interface ChatSidebarProps {
  stockCode?: string;
}

export function ChatSidebar({ stockCode }: ChatSidebarProps) {
  const {
    messages,
    isLoading,
    error,
    sendMessage,
    clearChat,
    stopGeneration,
  } = useChat({ contextStockCode: stockCode });

  const { data: session } = useSession();
  const { isPremium } = useSubscription();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const showChat = session && isPremium;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="fixed bottom-6 right-6 h-12 w-12 rounded-full shadow-lg z-50"
        >
          <MessageSquare className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[400px] sm:w-[450px] flex flex-col p-0">
        <SheetHeader className="px-4 py-3 border-b flex-row items-center justify-between space-y-0">
          <SheetTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Shorted AI
          </SheetTitle>
          {showChat && messages.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearChat}
              className="h-8 text-xs"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              New chat
            </Button>
          )}
        </SheetHeader>

        {showChat ? (
          <>
            {/* Messages area */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <MessageSquare className="h-8 w-8 text-muted-foreground mb-3" />
                  <p className="text-sm font-medium">Ask Shorted AI</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Get insights about short positions, stocks, and market trends
                  </p>
                  <div className="mt-4 w-full">
                    <QuickActions onSelect={sendMessage} stockCode={stockCode} />
                  </div>
                </div>
              ) : (
                <>
                  {messages.map((msg) => (
                    <ChatMessageBubble key={msg.id} message={msg} />
                  ))}
                  {isLoading && (
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

            {/* Input area */}
            <ChatInput
              onSend={sendMessage}
              onStop={stopGeneration}
              isLoading={isLoading}
            />
          </>
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
