"use client";

import { Bot, Loader2, User } from "lucide-react";
import { Message, MessageContent } from "~/@/components/ai-elements/message";
import {
  Source,
  SourcesContent,
  SourcesTrigger,
  Sources,
} from "~/@/components/ai-elements/sources";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolStatus,
} from "~/@/components/ai-elements/tool";
import { type ChatMessage } from "~/@/hooks/use-chat";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { cn } from "~/@/lib/utils";
import { ChatMarkdown } from "./chat-markdown";
import { RichToolBoundary } from "./chat-tool-boundary";
import { getRichToolResult, RichToolResultView } from "./chat-rich-tool-results";

type ToolCallData = NonNullable<ChatMessage["toolCalls"]>[number];

interface ChatMessageBubbleProps {
  message: ChatMessage;
  /**
   * True only for the newest turn while its request is in flight. A failed
   * request leaves its part marked "streaming", so the caret and the thinking
   * indicator must be gated on this, not on the part alone.
   */
  isActive?: boolean;
}

export function ChatMessageBubble({ message, isActive = false }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";
  const streaming = isActive && message.isStreaming === true;
  const toolCalls = message.toolCalls ?? [];
  const citations = message.citations ?? [];

  // A reply that failed before any text leaves nothing to show; the error
  // notice under the thread says what happened.
  if (
    !isUser &&
    !streaming &&
    !message.content &&
    toolCalls.length === 0 &&
    citations.length === 0
  ) {
    return null;
  }

  return (
    <Message from={message.role}>
      <div
        aria-hidden="true"
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>

      <MessageContent>
        <div
          className={cn(
            "rounded-lg px-3 py-2 text-sm",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-foreground",
          )}
        >
          {isUser ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : !message.content && streaming ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 aria-hidden="true" className="h-3 w-3 motion-safe:animate-spin" />
              <span>Thinking...</span>
            </div>
          ) : (
            <>
              {message.content && <ChatMarkdown content={message.content} />}
              {streaming && (
                <span
                  aria-hidden="true"
                  className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-current motion-safe:animate-pulse"
                />
              )}
            </>
          )}
        </div>

        {citations.length > 0 && (
          <Sources>
            <SourcesTrigger count={citations.length} />
            <SourcesContent>
              {citations.map((citation, index) => (
                <Source
                  key={`${citation.url}-${index}`}
                  // A citation URL is model- or feed-supplied: a link only when http(s).
                  href={safeExternalHref(citation.url)}
                  title={citation.reference || citation.sourceType}
                  subtitle={citation.reference ? citation.sourceType : undefined}
                />
              ))}
            </SourcesContent>
          </Sources>
        )}

        {toolCalls.length > 0 && (
          <div className="flex w-full flex-col gap-1.5">
            {toolCalls.map((toolCall, index) => (
              <ToolCallDetail key={`${toolCall.toolName}-${index}`} toolCall={toolCall} />
            ))}
          </div>
        )}
      </MessageContent>
    </Message>
  );
}

/**
 * One tool call. A result we can draw (a stock card, a short-interest chart)
 * opens by default, so the answer is visible without a click; everything else
 * starts collapsed.
 */
function ToolCallDetail({ toolCall }: { toolCall: ToolCallData }) {
  const rich = getRichToolResult(toolCall);
  const failure = toolFailure(toolCall.result);
  const status: ToolStatus = failure ? "failed" : "completed";

  return (
    <Tool defaultOpen={rich !== null}>
      <ToolHeader
        title={toolTitle(toolCall.toolName)}
        toolName={toolCall.toolName}
        status={status}
      />
      <ToolContent>
        {rich ? (
          <RichToolBoundary
            fallback={<RawToolDetail toolCall={toolCall} failure={failure} />}
          >
            <RichToolResultView result={rich} />
          </RichToolBoundary>
        ) : (
          <RawToolDetail toolCall={toolCall} failure={failure} />
        )}
      </ToolContent>
    </Tool>
  );
}

function RawToolDetail({
  toolCall,
  failure,
}: {
  toolCall: ToolCallData;
  failure?: string;
}) {
  const args = prettyArguments(toolCall.arguments);
  const preview =
    toolCall.result.length > 200
      ? `${toolCall.result.slice(0, 200)}...`
      : toolCall.result;

  return (
    <>
      {args && (
        <ToolInput>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background p-1.5 font-mono text-[10px]">
            {args}
          </pre>
        </ToolInput>
      )}
      {failure ? (
        <ToolOutput errorText={failure} />
      ) : (
        preview && (
          <ToolOutput>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background p-1.5 font-mono text-[10px]">
              {preview}
            </pre>
          </ToolOutput>
        )
      )}
    </>
  );
}

const TOOL_TITLES: Record<string, string> = {
  get_stock_details: "Stock details",
  query_short_positions: "Short positions",
  get_top_shorts: "Top shorts",
  get_peer_comparison: "Peer comparison",
  get_director_trades: "Director trades",
  get_economic_series: "Economic series",
};

function toolTitle(toolName: string): string {
  const title = TOOL_TITLES[toolName] as string | undefined;
  if (title) return title;
  const words = toolName.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the person sees for a failed tool call. The upstream text is never shown. */
const TOOL_FAILED_MESSAGE = "This data could not be retrieved.";

/**
 * The error a tool reported in its result, if it reported one. The chat service
 * records a failed call as plain text, "Error: " and the failure, which can
 * carry an upstream response body, so only the fact of the failure is shown.
 * A tool may also return an object with an `error` string.
 */
function toolFailure(result: string): string | undefined {
  if (result.startsWith("Error:")) return TOOL_FAILED_MESSAGE;
  if (!result.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== "string" || !error.trim()) return undefined;
    return error.trim().slice(0, 300);
  } catch {
    return undefined;
  }
}

function prettyArguments(args: string): string | undefined {
  if (!args.trim()) return undefined;
  try {
    return JSON.stringify(JSON.parse(args) as unknown, null, 2);
  } catch {
    return args;
  }
}
