"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { parseChatError, type ChatErrorInfo } from "~/@/lib/chat-errors";

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

/**
 * The conversation id from a `data-shorted-conversation` part, or undefined.
 *
 * Read structurally: the part type is owned by the stream adapter, so this
 * module does not import it. A part that arrives while the reply streams is
 * a transient data chunk, so it is handled here as it arrives instead of
 * waiting for the message list to contain it.
 */
export function conversationIdFromDataPart(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== "data-shorted-conversation") {
    return undefined;
  }
  if (!isRecord(value.data)) return undefined;
  const id = value.data.conversationId;
  return typeof id === "string" && id.trim() !== "" ? id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  const [sendError, setSendError] = useState<ChatErrorInfo | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  // Each history load takes the next number. Only the latest may change the
  // thread, so a slow answer to an earlier click cannot overwrite a later one,
  // and New chat cancels a load that is still pending.
  const loadSeqRef = useRef(0);
  const transport = useMemo(
    () =>
      new DefaultChatTransport<ShortedChatUIMessage>({
        api: "/api/chat",
      }),
    [],
  );

  const handleData = useCallback((dataPart: unknown) => {
    const id = conversationIdFromDataPart(dataPart);
    if (id) setConversationId(id);
  }, []);

  const {
    messages: uiMessages,
    setMessages: setUIMessages,
    sendMessage: sendAIMessage,
    regenerate,
    stop,
    clearError,
    status,
    error: aiError,
  } = useAIChat<ShortedChatUIMessage>({
    transport,
    onData: handleData,
  });

  const generationInFlight = status === "submitted" || status === "streaming";
  const isLoading = generationInFlight || isLoadingHistory;
  const messages = useMemo(
    () => uiMessages.map(uiMessageToChatMessage),
    [uiMessages],
  );
  const streamError = useMemo(
    () => (aiError ? parseChatError(aiError) : null),
    [aiError],
  );
  const error = sendError ?? streamError;

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
      const id =
        getShortedFinalData(uiMessage)?.conversationId ??
        uiMessage.parts
          .map((part) => conversationIdFromDataPart(part))
          .find((value) => value !== undefined);
      if (id) {
        setConversationId(id);
        return;
      }
    }
  }, [uiMessages]);

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmedContent = content.trim();
      if (!trimmedContent || generationInFlight || isLoadingHistory) return;

      setSendError(null);
      setHistoryError(null);
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
        setSendError(parseChatError(err));
      }
    },
    [
      clearError,
      conversationId,
      generationInFlight,
      isLoadingHistory,
      options.contextStockCode,
      sendAIMessage,
    ],
  );

  /**
   * Asks again after a failed reply. `regenerate` drops a failed assistant turn
   * from the thread and resends the person's last message. The request carries
   * the regenerate trigger, which the route forwards as a retry, so the chat
   * service reuses the stored question instead of storing it a second time.
   */
  const retry = useCallback(async () => {
    if (generationInFlight || isLoadingHistory || uiMessages.length === 0) return;

    setSendError(null);
    clearError();

    try {
      await regenerate({
        body: {
          conversationId: conversationId ?? "",
          contextStockCode: options.contextStockCode ?? "",
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setSendError(parseChatError(err));
    }
  }, [
    clearError,
    conversationId,
    generationInFlight,
    isLoadingHistory,
    options.contextStockCode,
    regenerate,
    uiMessages.length,
  ]);

  /**
   * Starts a new chat. The reply in flight is stopped first: it is still
   * streaming into the thread otherwise, and would be appended to the empty
   * thread and point the conversation back at the old one.
   */
  const clearChat = useCallback(async () => {
    loadSeqRef.current += 1;
    await stop();
    setUIMessages([]);
    setConversationId(null);
    setSendError(null);
    setHistoryError(null);
    setIsLoadingHistory(false);
    clearError();
  }, [clearError, setUIMessages, stop]);

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
      if (process.env.NODE_ENV !== "production") {
        console.error("Failed to fetch conversations:", err);
      }
    } finally {
      setIsLoadingConversations(false);
    }
  }, [options.userId]);

  const loadConversation = useCallback(
    async (convId: string) => {
      if (!options.userId) return;
      loadSeqRef.current += 1;
      const requestId = loadSeqRef.current;
      setIsLoadingHistory(true);
      setSendError(null);
      setHistoryError(null);
      clearError();
      // Stop the reply in flight before the thread is replaced, so nothing it
      // streams after this point can land in the conversation being opened.
      await stop();
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
        // A later click, or New chat, has superseded this load.
        if (requestId !== loadSeqRef.current) return;
        setUIMessages(loadedMessages.map(chatMessageToUIMessage));
        setConversationId(convId);
      } catch {
        if (requestId === loadSeqRef.current) {
          setHistoryError("Couldn't load that conversation. Please try again.");
        }
      } finally {
        if (requestId === loadSeqRef.current) setIsLoadingHistory(false);
      }
    },
    [clearError, options.userId, setUIMessages, stop],
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
          await clearChat();
        }
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.error("Failed to delete conversation:", err);
        }
      }
    },
    [options.userId, conversationId, clearChat],
  );

  return {
    messages,
    status,
    isLoading,
    isLoadingHistory,
    error,
    historyError,
    conversationId,
    conversations,
    isLoadingConversations,
    sendMessage,
    retry,
    clearChat,
    stopGeneration,
    fetchConversations,
    loadConversation,
    deleteConversation,
  };
}
