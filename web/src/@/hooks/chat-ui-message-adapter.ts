import type { UIMessage } from "ai";
import type { ChatCitation, ChatMessage } from "./use-chat";

export interface ShortedFinalData {
  conversationId?: string;
  toolCalls?: ChatMessage["toolCalls"];
  citations?: ChatCitation[];
  createdAt?: string;
}

/**
 * Emitted as soon as the chat service names the conversation, before any text,
 * so the client knows the id even when the turn later fails.
 */
export interface ShortedConversationData {
  conversationId: string;
}

export type ShortedChatUIMessage = UIMessage<
  { createdAt?: string },
  {
    "shorted-final": ShortedFinalData;
    "shorted-conversation": ShortedConversationData;
  }
>;

/**
 * The error body every non-2xx chat response carries, and the `errorText` of an
 * in-stream error. The chat UI renders from this shape, so it is a contract:
 * change a field here and the UI branch must change with it.
 */
export type ChatErrorCode =
  | "unauthenticated"
  | "premium_required"
  | "rate_limited"
  | "invalid_request"
  | "unavailable";

export type ChatLimitKind = "per_minute" | "daily" | "monthly" | "global";

export interface ChatErrorBody {
  /** Short, stable label for the error (the legacy `error` string). */
  error: string;
  code: ChatErrorCode;
  /** A user-facing sentence. */
  message: string;
  retryAfterSeconds?: number;
  limitKind?: ChatLimitKind;
  /** Unix seconds at which the refused window has room again. */
  resetAt?: number;
}

/**
 * Parses the `errorText` of an in-stream error back into the contract. Returns
 * undefined for anything else, so a plain-text error from another source is not
 * mistaken for a contract error.
 */
export function parseChatErrorBody(
  errorText: string | undefined,
): ChatErrorBody | undefined {
  if (!errorText) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(errorText);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as ChatErrorBody).code === "string" &&
      typeof (parsed as ChatErrorBody).message === "string"
    ) {
      return parsed as ChatErrorBody;
    }
  } catch {
    // Not JSON: not a contract error.
  }
  return undefined;
}

type ShortedMessagePart = ShortedChatUIMessage["parts"][number];
interface ShortedTextPart {
  type: "text";
  text: string;
  state?: "streaming" | "done";
}
interface ShortedFinalPart {
  type: "data-shorted-final";
  data: ShortedFinalData;
  id?: string;
  transient?: boolean;
}

export function chatMessageToUIMessage(
  message: ChatMessage,
): ShortedChatUIMessage {
  const parts: ShortedChatUIMessage["parts"] = [];
  if (message.content) {
    parts.push({
      type: "text",
      text: message.content,
      state: message.isStreaming ? "streaming" : "done",
    });
  }

  const hasToolCalls = (message.toolCalls?.length ?? 0) > 0;
  const hasCitations = (message.citations?.length ?? 0) > 0;
  if (
    message.role === "assistant" &&
    (hasToolCalls || hasCitations)
  ) {
    parts.push({
      type: "data-shorted-final",
      id: `${message.id}-shorted-final`,
      data: {
        toolCalls: message.toolCalls,
        citations: message.citations,
        createdAt: message.createdAt.toISOString(),
      },
    });
  }

  return {
    id: message.id,
    role: message.role,
    metadata: { createdAt: message.createdAt.toISOString() },
    parts,
  };
}

export function uiMessageToChatMessage(
  message: ShortedChatUIMessage,
): ChatMessage {
  const textParts = message.parts.filter(isShortedTextPart);
  const finalData = getShortedFinalData(message);
  const createdAt =
    parseDate(finalData?.createdAt) ??
    parseDate(message.metadata?.createdAt) ??
    new Date();

  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: textParts.map(textFromPart).join(""),
    toolCalls: finalData?.toolCalls?.length ? finalData.toolCalls : undefined,
    citations: finalData?.citations?.length ? finalData.citations : undefined,
    isStreaming:
      message.role === "assistant" &&
      textParts.some((part) => part.state === "streaming"),
    createdAt,
  };
}

export function extractLatestUserText(
  messages: ShortedChatUIMessage[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }

    const text = message.parts
      .filter(isShortedTextPart)
      .map(textFromPart)
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function getShortedFinalData(
  message: ShortedChatUIMessage,
): ShortedFinalData | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part && isShortedFinalPart(part)) {
      return part.data;
    }
  }
  return undefined;
}

function isShortedTextPart(part: ShortedMessagePart): part is ShortedTextPart {
  return part.type === "text";
}

function isShortedFinalPart(part: ShortedMessagePart): part is ShortedFinalPart {
  return part.type === "data-shorted-final";
}

function textFromPart(part: ShortedTextPart): string {
  return part.text;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
