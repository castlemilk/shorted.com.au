"use client";

import { useState } from "react";
import { type ChatMessage } from "~/@/hooks/use-chat";
import { cn } from "~/@/lib/utils";
import {
  Bot,
  User,
  Wrench,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/@/components/ui/collapsible";
import { Badge } from "~/@/components/ui/badge";
import { ChatMarkdown } from "./chat-markdown";
import { ChatRichToolResults } from "./chat-rich-tool-results";

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
          {isUser ? (
            <div className="whitespace-pre-wrap break-words">
              {message.content}
            </div>
          ) : message.isStreaming && !message.content ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Thinking...</span>
            </div>
          ) : (
            <ChatMarkdown content={message.content} />
          )}
        </div>

        <ChatRichToolResults toolCalls={message.toolCalls} />

        {/* Citations */}
        {message.citations && message.citations.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {message.citations.map((c, i) => (
              <Badge
                key={i}
                variant="secondary"
                className="text-[10px] h-5 px-1.5 gap-1"
              >
                {c.sourceType}
                {c.reference && (
                  <span className="text-muted-foreground">{c.reference}</span>
                )}
                {c.url && (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-primary"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </Badge>
            ))}
          </div>
        )}

        {/* Tool calls (collapsed by default) */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <Wrench className="h-3 w-3" />
              {message.toolCalls.length} tool call
              {message.toolCalls.length !== 1 ? "s" : ""}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 space-y-1.5">
              {message.toolCalls.map((tc, i) => (
                <ToolCallDetail key={i} toolCall={tc} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
}

function ToolCallDetail({
  toolCall,
}: {
  toolCall: { toolName: string; arguments: string; result: string };
}) {
  const [expanded, setExpanded] = useState(false);

  let parsedArgs: string | null = null;
  try {
    const parsed: unknown = JSON.parse(toolCall.arguments);
    parsedArgs = JSON.stringify(parsed, null, 2);
  } catch {
    parsedArgs = toolCall.arguments;
  }

  let resultPreview = toolCall.result;
  if (resultPreview.length > 200) {
    resultPreview = resultPreview.slice(0, 200) + "...";
  }

  return (
    <div className="rounded bg-muted/50 px-2 py-1.5 text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 w-full text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Badge variant="outline" className="text-[10px]">
          {toolCall.toolName}
        </Badge>
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5 pl-4">
          {parsedArgs && (
            <div>
              <p className="text-[10px] font-medium text-muted-foreground mb-0.5">
                Arguments
              </p>
              <pre className="bg-background rounded p-1.5 text-[10px] font-mono overflow-x-auto whitespace-pre-wrap">
                {parsedArgs}
              </pre>
            </div>
          )}
          {toolCall.result && (
            <div>
              <p className="text-[10px] font-medium text-muted-foreground mb-0.5">
                Result
              </p>
              <pre className="bg-background rounded p-1.5 text-[10px] font-mono overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto">
                {resultPreview}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
