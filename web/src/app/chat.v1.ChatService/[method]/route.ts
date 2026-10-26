import type { NextRequest } from "next/server";
import {
  ALLOWED_CHAT_METHODS,
  authorizeChatRequest,
  buildUpstreamHeaders,
  chatErrorBody,
  chatErrorResponse,
  chatErrorResponseFromUpstream,
  filterResponseHeaders,
} from "@/lib/chat-server-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    method?: string;
  };
}

export async function POST(request: NextRequest, context: RouteContext) {
  const method = context.params.method ?? "";
  if (!ALLOWED_CHAT_METHODS.has(method)) {
    return chatErrorResponse(
      404,
      chatErrorBody(
        "invalid_request",
        "Unknown chat method",
        "That chat request is not supported.",
      ),
    );
  }

  const access = await authorizeChatRequest(request, method);
  if (!access.ok) {
    return access.response;
  }

  const upstreamURL = new URL(
    `/chat.v1.ChatService/${method}`,
    access.value.chatServiceBaseURL,
  );
  const headers = buildUpstreamHeaders(request.headers, {
    internalSecret: access.value.internalSecret,
    userID: access.value.userID,
    userEmail: access.value.userEmail,
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamURL.toString(), {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
      // Required by Node fetch when forwarding a stream body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch {
    // The chat service could not be reached. Nothing was streamed, so this is
    // a plain status, not an in-stream error.
    return chatErrorResponse(
      503,
      chatErrorBody(
        "unavailable",
        "Chat unavailable",
        "Chat is temporarily unavailable.",
        { retryAfterSeconds: 60 },
      ),
      { "Retry-After": "60" },
    );
  }

  // A non-2xx answer is rebuilt into the contract. A 2xx stream, including a
  // Connect error carried inside it, is passed through unchanged.
  if (!upstreamResponse.ok) {
    return chatErrorResponseFromUpstream(upstreamResponse);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: filterResponseHeaders(upstreamResponse.headers),
  });
}
