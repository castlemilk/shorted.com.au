import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { ChatService } from "~/gen/chat/v1/chat_pb";

export interface UpstreamToolCall {
  toolName: string;
  arguments: string;
  result: string;
}

export interface UpstreamCitation {
  sourceType: string;
  reference: string;
  url: string;
}

export interface UpstreamChatChunk {
  conversationId?: string;
  chunk?: string;
  isComplete?: boolean;
  toolCalls?: UpstreamToolCall[];
  citations?: UpstreamCitation[];
}

export interface StreamChatFromUpstreamOptions {
  conversationId: string;
  message: string;
  contextStockCode: string;
  userID: string;
  userEmail: string;
  internalSecret: string;
  chatServiceBaseURL: string;
  signal?: AbortSignal;
}

interface ChatServiceClient {
  sendMessage(
    request: {
      conversationId: string;
      message: string;
      contextStockCode: string;
    },
    options: { signal?: AbortSignal },
  ): AsyncIterable<UpstreamChatChunk>;
}

export async function* streamChatFromUpstream(
  options: StreamChatFromUpstreamOptions,
): AsyncIterable<UpstreamChatChunk> {
  const transport = createConnectTransport({
    baseUrl: options.chatServiceBaseURL,
    interceptors: [
      (next) => async (request) => {
        if (options.internalSecret) {
          request.header.set("x-internal-secret", options.internalSecret);
        }
        request.header.set("x-user-id", options.userID);
        if (options.userEmail) {
          request.header.set("x-user-email", options.userEmail);
        }
        return next(request);
      },
    ],
  });
  const client = createClient(
    ChatService,
    transport,
  ) as unknown as ChatServiceClient;

  for await (const chunk of client.sendMessage(
    {
      conversationId: options.conversationId,
      message: options.message,
      contextStockCode: options.contextStockCode,
    },
    { signal: options.signal },
  )) {
    yield {
      conversationId: chunk.conversationId,
      chunk: chunk.chunk,
      isComplete: chunk.isComplete,
      toolCalls: chunk.toolCalls?.map(
        (toolCall: {
          toolName: string;
          arguments: string;
          result: string;
        }) => ({
          toolName: toolCall.toolName,
          arguments: toolCall.arguments,
          result: toolCall.result,
        }),
      ),
      citations: chunk.citations?.map(
        (citation: { sourceType: string; reference: string; url: string }) => ({
          sourceType: citation.sourceType,
          reference: citation.reference,
          url: citation.url,
        }),
      ),
    };
  }
}
