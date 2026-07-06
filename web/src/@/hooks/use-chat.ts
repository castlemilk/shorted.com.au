"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useChat as useAIChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ChatService } from "~/gen/chat/v1/chat_pb";
import {
  chatMessageToUIMessage,
  getShortedFinalData,
  uiMessageToChatMessage,
  type ShortedChatUIMessage,
} from "./chat-ui-message-adapter";

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

function createChatTransport() {
  return createConnectTransport({
    baseUrl: "",
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getChatClient(): any {
  const transport = createChatTransport();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return
  return createClient(ChatService as any, transport) as any;
}

export function useChat(options: UseChatOptions = {}) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const transport = useMemo(
    () =>
      new DefaultChatTransport<ShortedChatUIMessage>({
        api: "/api/chat",
      }),
    [],
  );
  const {
    messages: uiMessages,
    setMessages: setUIMessages,
    sendMessage: sendAIMessage,
    stop,
    clearError,
    status,
    error: aiError,
  } = useAIChat<ShortedChatUIMessage>({
    transport,
  });

  const generationInFlight = status === "submitted" || status === "streaming";
  const isLoading = generationInFlight || isLoadingHistory;
  const messages = useMemo(
    () => uiMessages.map(uiMessageToChatMessage),
    [uiMessages],
  );
  const error = manualError ?? (aiError ? aiError.message : null);

  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  useEffect(() => {
    for (let index = uiMessages.length - 1; index >= 0; index -= 1) {
      const uiMessage = uiMessages[index];
      if (!uiMessage) {
        continue;
      }
      const data = getShortedFinalData(uiMessage);
      if (data?.conversationId) {
        setConversationId(data.conversationId);
        return;
      }
    }
  }, [uiMessages]);

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmedContent = content.trim();
      if (!trimmedContent || generationInFlight) return;

      setManualError(null);
      clearError();

      try {
        await sendAIMessage(
          { text: trimmedContent },
          {
            body: {
              conversationId: conversationId ?? "",
              contextStockCode: options.contextStockCode ?? "",
            },
          },
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        setManualError(
          err instanceof Error ? err.message : "Failed to send message",
        );
      }
    },
    [
      clearError,
      conversationId,
      generationInFlight,
      options.contextStockCode,
      sendAIMessage,
    ],
  );

  const clearChat = useCallback(() => {
    setUIMessages([]);
    setConversationId(null);
    setManualError(null);
    clearError();
  }, [clearError, setUIMessages]);

  const stopGeneration = useCallback(() => {
    void stop();
  }, [stop]);

  const fetchConversations = useCallback(async () => {
    if (!options.userId) return;
    setIsLoadingConversations(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const client = getChatClient();
      /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
      const resp = await client.listConversations({ limit: 30, offset: 0 });
      const convs: ConversationSummary[] = (resp.conversations ?? []).map(
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
      setIsLoadingHistory(true);
      setManualError(null);
      clearError();
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const client = getChatClient();
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
        setUIMessages(loadedMessages.map(chatMessageToUIMessage));
        setConversationId(convId);
      } catch (err) {
        setManualError(
          err instanceof Error ? err.message : "Failed to load conversation",
        );
      } finally {
        setIsLoadingHistory(false);
      }
    },
    [clearError, options.userId, setUIMessages],
  );

  const deleteConversation = useCallback(
    async (convId: string) => {
      if (!options.userId) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const client = getChatClient();
        /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
        await client.deleteConversation({ conversationId: convId });
        /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
        setConversations((prev) => prev.filter((c) => c.id !== convId));
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
