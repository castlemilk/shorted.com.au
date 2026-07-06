import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  extractLatestUserText,
  type ShortedChatUIMessage,
  type ShortedFinalData,
} from "@/hooks/chat-ui-message-adapter";
import { authorizeChatRequest } from "@/lib/chat-server-guards";
import {
  streamChatFromUpstream,
  type UpstreamCitation,
  type UpstreamToolCall,
} from "@/lib/chat-upstream-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: {
    conversationId?: unknown;
    contextStockCode?: unknown;
    messages?: unknown;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid chat request" }, { status: 400 });
  }

  const messages = Array.isArray(body.messages)
    ? (body.messages as ShortedChatUIMessage[])
    : [];
  const message = extractLatestUserText(messages);
  if (!message) {
    return NextResponse.json(
      { error: "A user message is required" },
      { status: 400 },
    );
  }

  const access = await authorizeChatRequest(request, "SendMessage");
  if (!access.ok) {
    return access.response;
  }

  const textPartID = "shorted-assistant-text";
  const stream = createUIMessageStream({
    originalMessages: messages,
    async execute({ writer }) {
      let conversationId = stringValue(body.conversationId);
      let toolCalls: UpstreamToolCall[] = [];
      let citations: UpstreamCitation[] = [];

      writer.write({ type: "text-start", id: textPartID });

      for await (const chunk of streamChatFromUpstream({
        conversationId,
        message,
        contextStockCode: stringValue(body.contextStockCode),
        userID: access.value.userID,
        userEmail: access.value.userEmail,
        internalSecret: access.value.internalSecret,
        signal: request.signal,
      })) {
        if (chunk.conversationId) {
          conversationId = chunk.conversationId;
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
    onError() {
      return "Chat is temporarily unavailable.";
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
