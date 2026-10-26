import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import type { NextRequest } from "next/server";
import {
  extractLatestUserText,
  type ShortedChatUIMessage,
  type ShortedFinalData,
} from "@/hooks/chat-ui-message-adapter";
import {
  authorizeChatRequest,
  CHAT_MAX_MESSAGE_CHARS,
  chatErrorBody,
  chatErrorFromUpstreamError,
  chatErrorResponse,
} from "@/lib/chat-server-guards";
import {
  streamChatFromUpstream,
  type UpstreamCitation,
  type UpstreamToolCall,
} from "@/lib/chat-upstream-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tool-heavy turn runs several database-backed tool calls before its text
// ends. The default 15s cut those off mid-stream. vercel.json's src/app/**
// catch-all sets 15s for every route; this export raises this route to 60s.
// scripts/verify-vercel-function-limits.mjs checks the built value in the deploy
// workflow, so removing the export fails the deploy.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let body: {
    conversationId?: unknown;
    contextStockCode?: unknown;
    messages?: unknown;
    trigger?: unknown;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return chatErrorResponse(
      400,
      chatErrorBody(
        "invalid_request",
        "Invalid chat request",
        "The chat request could not be read. Refresh the page and try again.",
      ),
    );
  }

  const messages = Array.isArray(body.messages)
    ? (body.messages as ShortedChatUIMessage[])
    : [];
  const message = extractLatestUserText(messages);
  if (!message) {
    return chatErrorResponse(
      400,
      chatErrorBody(
        "invalid_request",
        "A user message is required",
        "Type a message to send.",
      ),
    );
  }

  // Before authorization, so an oversized message spends no rate-limit token.
  // Counted in code points, which is how the chat service counts runes.
  if (Array.from(message).length > CHAT_MAX_MESSAGE_CHARS) {
    return chatErrorResponse(
      400,
      chatErrorBody(
        "invalid_request",
        "Message too long",
        `Messages can be up to ${CHAT_MAX_MESSAGE_CHARS} characters. Shorten yours and try again.`,
      ),
    );
  }

  const access = await authorizeChatRequest(request, "SendMessage");
  if (!access.ok) {
    return access.response;
  }

  // The AI SDK sends regenerate-message when the person asks again after a
  // failed reply. The chat service reuses the question when the failed attempt
  // stored it, and removes only a partial reply that attempt kept. A question
  // that was never stored is stored as new, and a complete reply is never
  // removed, so the trigger alone is safe to forward.
  const retry = body.trigger === "regenerate-message";

  const textPartID = "shorted-assistant-text";
  const stream = createUIMessageStream({
    originalMessages: messages,
    async execute({ writer }) {
      let conversationId = stringValue(body.conversationId);
      let conversationAnnounced = false;
      let toolCalls: UpstreamToolCall[] = [];
      let citations: UpstreamCitation[] = [];

      writer.write({ type: "text-start", id: textPartID });

      try {
        for await (const chunk of streamChatFromUpstream({
          conversationId,
          message,
          contextStockCode: stringValue(body.contextStockCode),
          retry,
          userID: access.value.userID,
          userEmail: access.value.userEmail,
          internalSecret: access.value.internalSecret,
          chatServiceBaseURL: access.value.chatServiceBaseURL,
          signal: request.signal,
        })) {
          if (chunk.conversationId) {
            conversationId = chunk.conversationId;
            // Announced as soon as it is known, before any text. If the turn
            // fails later the client still has the id, so the next send
            // continues this conversation instead of starting a second one.
            if (!conversationAnnounced) {
              writer.write({
                type: "data-shorted-conversation",
                data: { conversationId },
              });
              conversationAnnounced = true;
            }
          }
          if (chunk.chunk) {
            writer.write({
              type: "text-delta",
              id: textPartID,
              delta: chunk.chunk,
            });
          }
          if (chunk.toolCalls?.length) {
            toolCalls = chunk.toolCalls;
          }
          if (chunk.citations?.length) {
            citations = chunk.citations;
          }
        }
      } catch (error) {
        // The stream has already started, so the status line cannot carry the
        // failure. It travels as an in-stream error chunk whose text is the
        // contract body, and the text part is closed first.
        writer.write({ type: "text-end", id: textPartID });
        writer.write({
          type: "error",
          errorText: JSON.stringify(chatErrorFromUpstreamError(error)),
        });
        return;
      }

      writer.write({ type: "text-end", id: textPartID });
      writer.write({
        type: "data-shorted-final",
        id: "shorted-final",
        data: {
          conversationId,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          citations: citations.length ? citations : undefined,
          createdAt: new Date().toISOString(),
        } satisfies ShortedFinalData,
      });
    },
    onError(error) {
      return JSON.stringify(chatErrorFromUpstreamError(error));
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
