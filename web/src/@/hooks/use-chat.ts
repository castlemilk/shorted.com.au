"use client";

import { useState, useCallback, useRef } from "react";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ChatService } from "~/gen/chat/v1/chat_pb";

export interface ChatCitation {
  sourceType: string;
  reference: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: { toolName: string; arguments: string; result: string }[];
  citations?: ChatCitation[];
  isStreaming?: boolean;
  createdAt: Date;
}

export interface ConversationSummary {
  id: string;
  title: string;
  contextStockCode: string;
  updatedAt: Date;
  messageCount: number;
}

interface UseChatOptions {
  contextStockCode?: string;
  userId?: string;
}

function createChatTransport(userId?: string) {
  return createConnectTransport({
    baseUrl: "",
    interceptors: userId
      ? [
          (next) => async (req) => {
            req.header.set("X-User-Id", userId);
            return next(req);
          },
        ]
      : [],
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getChatClient(userId?: string): any {
  const transport = createChatTransport(userId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return
  return createClient(ChatService as any, transport) as any;
}

export function useChat(options: UseChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isLoading) return;

      setError(null);
      setIsLoading(true);

      // Add user message optimistically
      const userMsg: ChatMessage = {
        id: `temp-${Date.now()}`,
        role: "user",
        content,
        createdAt: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Add streaming placeholder
      const streamingMsgId = `streaming-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: streamingMsgId,
          role: "assistant",
          content: "",
          isStreaming: true,
          createdAt: new Date(),
        },
      ]);

      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const client = getChatClient(options.userId);

        abortRef.current = new AbortController();

        let fullContent = "";
        let finalConvId = conversationId ?? "";
        let toolCalls: ChatMessage["toolCalls"] = [];
        let citations: ChatCitation[] = [];

        /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
        for await (const chunk of client.sendMessage(
          {
            conversationId: conversationId ?? "",
            message: content,
            contextStockCode: options.contextStockCode ?? "",
          },
          { signal: abortRef.current.signal },
        )) {
          if (chunk.conversationId) {
            finalConvId = chunk.conversationId;
          }
          if (chunk.chunk) {
            fullContent += chunk.chunk;
            // Update streaming message incrementally
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingMsgId
                  ? { ...m, content: fullContent }
                  : m,
              ),
            );
          }
          if (chunk.toolCalls?.length) {
            toolCalls = chunk.toolCalls.map(
              (tc: {
                toolName: string;
                arguments: string;
                result: string;
              }) => ({
                toolName: tc.toolName,
                arguments: tc.arguments,
                result: tc.result,
              }),
            );
          }
          if (chunk.citations?.length) {
            citations = chunk.citations.map(
              (c: { sourceType: string; reference: string; url: string }) => ({
                sourceType: c.sourceType,
                reference: c.reference,
                url: c.url,
              }),
            );
          }
        }
        /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */

        if (finalConvId) {
          setConversationId(finalConvId);
        }

        // Replace streaming placeholder with final message
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingMsgId
              ? {
                  ...m,
                  id: `msg-${Date.now()}`,
                  content: fullContent,
                  toolCalls: toolCalls?.length ? toolCalls : undefined,
                  citations: citations.length ? citations : undefined,
                  isStreaming: false,
                }
              : m,
          ),
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // Remove the streaming placeholder on abort
          setMessages((prev) =>
            prev.filter((m) => m.id !== streamingMsgId),
          );
          return;
        }
        const errorMessage =
          err instanceof Error ? err.message : "Failed to send message";
        setError(errorMessage);
        // Remove the optimistic user message and streaming placeholder on error
        setMessages((prev) =>
          prev.filter(
            (m) => m.id !== userMsg.id && m.id !== streamingMsgId,
          ),
        );
      } finally {
        setIsLoading(false);
        abortRef.current = null;
      }
    },
    [isLoading, conversationId, options.contextStockCode, options.userId],
  );

  const clearChat = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setError(null);
  }, []);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  const fetchConversations = useCallback(async () => {
    if (!options.userId) return;
    setIsLoadingConversations(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const client = getChatClient(options.userId);
      /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
      const resp = await client.listConversations({ limit: 30, offset: 0 });
      const convs: ConversationSummary[] = (
        resp.conversations ?? []
      ).map(
        (c: {
          id: string;
          title: string;
          contextStockCode: string;
          updatedAt?: { seconds: bigint };
          messageCount: number;
        }) => ({
          id: c.id,
          title: c.title,
          contextStockCode: c.contextStockCode,
          updatedAt: c.updatedAt
            ? new Date(Number(c.updatedAt.seconds) * 1000)
            : new Date(),
          messageCount: c.messageCount,
        }),
      );
      /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
      setConversations(convs);
    } catch (err) {
      console.error("Failed to fetch conversations:", err);
    } finally {
      setIsLoadingConversations(false);
    }
  }, [options.userId]);

  const loadConversation = useCallback(
    async (convId: string) => {
      if (!options.userId) return;
      setIsLoading(true);
      setError(null);
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const client = getChatClient(options.userId);
        /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
        const resp = await client.getConversationHistory({
          conversationId: convId,
        });
        const loadedMessages: ChatMessage[] = (resp.messages ?? []).map(
          (m: {
            id: string;
            role: number;
            content: string;
            toolCalls?: {
              toolName: string;
              arguments: string;
              result: string;
            }[];
            citations?: {
              sourceType: string;
              reference: string;
              url: string;
            }[];
            createdAt?: { seconds: bigint };
          }) => ({
            id: m.id,
            role: m.role === 2 ? "assistant" : ("user" as const),
            content: m.content,
            toolCalls: m.toolCalls?.length ? m.toolCalls : undefined,
            citations: m.citations?.length ? m.citations : undefined,
            createdAt: m.createdAt
              ? new Date(Number(m.createdAt.seconds) * 1000)
              : new Date(),
          }),
        );
        /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
        setMessages(loadedMessages);
        setConversationId(convId);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load conversation";
        setError(errorMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [options.userId],
  );

  const deleteConversation = useCallback(
    async (convId: string) => {
      if (!options.userId) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const client = getChatClient(options.userId);
        /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
        await client.deleteConversation({ conversationId: convId });
        /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
        setConversations((prev) => prev.filter((c) => c.id !== convId));
        // If we deleted the active conversation, clear it
        if (conversationId === convId) {
          clearChat();
        }
      } catch (err) {
        console.error("Failed to delete conversation:", err);
      }
    },
    [options.userId, conversationId, clearChat],
  );

  return {
    messages,
    isLoading,
    error,
    conversationId,
    conversations,
    isLoadingConversations,
    sendMessage,
    clearChat,
    stopGeneration,
    fetchConversations,
    loadConversation,
    deleteConversation,
  };
}
