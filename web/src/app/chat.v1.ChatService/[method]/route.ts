import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  ALLOWED_CHAT_METHODS,
  authorizeChatRequest,
  buildUpstreamHeaders,
  filterResponseHeaders,
  resolveChatServiceBaseURL,
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
    return NextResponse.json({ error: "Unknown chat method" }, { status: 404 });
  }

  const access = await authorizeChatRequest(request, method);
  if (!access.ok) {
    return access.response;
  }

  const upstreamURL = new URL(
    `/chat.v1.ChatService/${method}`,
    resolveChatServiceBaseURL(process.env),
  );
  const headers = buildUpstreamHeaders(request.headers, {
    internalSecret: access.value.internalSecret,
    userID: access.value.userID,
    userEmail: access.value.userEmail,
  });

  const upstreamResponse = await fetch(upstreamURL.toString(), {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    // Required by Node fetch when forwarding a stream body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: filterResponseHeaders(upstreamResponse.headers),
  });
}
