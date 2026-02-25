"use client";

import { useState, useCallback, useRef } from "react";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ChatService } from "~/gen/chat/v1/chat_pb";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: { toolName: string; arguments: string; result: string }[];
  createdAt: Date;
}

interface UseChatOptions {
  contextStockCode?: string;
}

export function useChat(options: UseChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

      try {
        const transport = createConnectTransport({ baseUrl: "" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        const client = createClient(ChatService as any, transport) as any;

        abortRef.current = new AbortController();

        // Use server streaming RPC
        let fullContent = "";
        let finalConvId = conversationId ?? "";
        let toolCalls: ChatMessage["toolCalls"] = [];

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
          }
          if (chunk.toolCalls?.length) {
            toolCalls = chunk.toolCalls.map((tc: { toolName: string; arguments: string; result: string }) => ({
              toolName: tc.toolName,
              arguments: tc.arguments,
              result: tc.result,
            }));
          }
        }
        /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */

        if (finalConvId) {
          setConversationId(finalConvId);
        }

        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content: fullContent,
          toolCalls: toolCalls?.length ? toolCalls : undefined,
          createdAt: new Date(),
        };

        setMessages((prev) => [...prev, assistantMsg]);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        const errorMessage =
          err instanceof Error ? err.message : "Failed to send message";
        setError(errorMessage);
        // Remove the optimistic user message on error
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      } finally {
        setIsLoading(false);
        abortRef.current = null;
      }
    },
    [isLoading, conversationId, options.contextStockCode],
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

  return {
    messages,
    isLoading,
    error,
    conversationId,
    sendMessage,
    clearChat,
    stopGeneration,
  };
}
