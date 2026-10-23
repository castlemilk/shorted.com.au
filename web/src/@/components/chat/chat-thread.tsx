"use client";

import dynamic from "next/dynamic";
import { Loader2, MessageSquare } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "~/@/components/ai-elements/conversation";
import type { PromptInputStatus } from "~/@/components/ai-elements/prompt-input";
import type { ChatMessage } from "~/@/hooks/use-chat";
import type { ChatErrorInfo } from "~/@/lib/chat-errors";
import { ChatErrorNotice } from "./chat-error-notice";
import { QuickActions } from "./quick-actions";

// Lazy-load the message renderer: it pulls the whole streamdown markdown stack
// (remark/rehype + KaTeX + shiki) which the thread does not need until a
// message actually renders.
const ChatMessageBubble = dynamic(
  () => import("./chat-message").then((m) => m.ChatMessageBubble),
  {
    ssr: false,
    loading: () => (
      <div className="h-8 w-2/3 animate-pulse rounded-md bg-muted/40" />
    ),
  },
);

interface ChatThreadProps {
  messages: ChatMessage[];
  status: PromptInputStatus;
  error: ChatErrorInfo | null;
  historyError: string | null;
  onRetry: () => void;
  onSuggest: (question: string) => void;
  stockCode?: string;
  variant: "page" | "sheet";
  className?: string;
}

/**
 * The conversation: the message list with stick-to-bottom, the empty state's
 * suggestions, the reply in progress and any error. Remounts when the thread
 * changes to another conversation, so each one opens at its latest message.
 */
export function ChatThread({
  messages,
  status,
  error,
  historyError,
  onRetry,
  onSuggest,
  stockCode,
  variant,
  className,
}: ChatThreadProps) {
  const isGenerating = status === "submitted" || status === "streaming";
  const lastMessage = messages[messages.length - 1];
  const awaitingReply = isGenerating && lastMessage?.role !== "assistant";
  const threadKey = messages[0]?.id ?? "empty";

  return (
    <Conversation key={threadKey} className={className}>
      <ConversationContent
        aria-busy={isGenerating}
        className={variant === "page" ? "p-4 md:p-6" : "p-4"}
      >
        {messages.length === 0 ? (
          <EmptyThread variant={variant} stockCode={stockCode} onSuggest={onSuggest} />
        ) : (
          messages.map((message, index) => (
            <ChatMessageBubble
              key={message.id}
              message={message}
              isActive={isGenerating && index === messages.length - 1}
            />
          ))
        )}

        {awaitingReply && (
          <div
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />
            Thinking...
          </div>
        )}

        {error && (
          <ChatErrorNotice
            error={error}
            onRetry={error.code === "unavailable" ? onRetry : undefined}
          />
        )}

        {historyError && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {historyError}
          </p>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function EmptyThread({
  variant,
  stockCode,
  onSuggest,
}: {
  variant: "page" | "sheet";
  stockCode?: string;
  onSuggest: (question: string) => void;
}) {
  if (variant === "page") {
    return (
      <div className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center text-center">
        <MessageSquare aria-hidden="true" className="mb-4 h-10 w-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Ask Shorted AI</h2>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">
          Get insights about short positions, stocks, director trades, peer
          comparisons, and market trends.
        </p>
        <QuickActions onSelect={onSuggest} stockCode={stockCode} />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <MessageSquare aria-hidden="true" className="mb-3 h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-medium">Ask Shorted AI</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Get insights about short positions, stocks, and market trends
      </p>
      <div className="mt-4 w-full">
        <QuickActions onSelect={onSuggest} stockCode={stockCode} />
      </div>
    </div>
  );
}
