import type { UIMessage } from "ai";
import type { ChatCitation, ChatMessage } from "./use-chat";

export interface ShortedFinalData {
  conversationId?: string;
  toolCalls?: ChatMessage["toolCalls"];
  citations?: ChatCitation[];
  createdAt?: string;
}

export type ShortedChatUIMessage = UIMessage<
  { createdAt?: string },
  { "shorted-final": ShortedFinalData }
>;

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
