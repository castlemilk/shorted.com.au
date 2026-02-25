"use client";

import { type ChatMessage } from "~/@/hooks/use-chat";
import { cn } from "~/@/lib/utils";
import { Bot, User, Wrench } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/@/components/ui/collapsible";
import { Badge } from "~/@/components/ui/badge";

interface ChatMessageBubbleProps {
  message: ChatMessage;
}

export function ChatMessageBubble({ message }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-3", isUser ? "flex-row-reverse" : "flex-row")}>
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div
        className={cn(
          "flex flex-col gap-1 max-w-[85%]",
          isUser ? "items-end" : "items-start",
        )}
      >
        <div
          className={cn(
            "rounded-lg px-3 py-2 text-sm",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-foreground",
          )}
        >
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>

        {/* Tool calls (collapsed by default) */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <Wrench className="h-3 w-3" />
              {message.toolCalls.length} tool call
              {message.toolCalls.length !== 1 ? "s" : ""}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 space-y-1">
              {message.toolCalls.map((tc, i) => (
                <div
                  key={i}
                  className="rounded bg-muted/50 px-2 py-1 text-xs font-mono"
                >
                  <Badge variant="outline" className="text-[10px] mb-1">
                    {tc.toolName}
                  </Badge>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
}
