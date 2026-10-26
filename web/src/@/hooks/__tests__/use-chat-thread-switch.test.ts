import { act, renderHook } from "@testing-library/react";
import { useChat } from "../use-chat";

// The AI SDK and Connect runtime are ESM-only and do not load under jest, so
// they are replaced. What is under test is the order the hook calls the SDK in
// (stop before the thread is replaced) and which history answer it keeps. The
// SDK's own stop semantics are checked against the real package in the probe
// that accompanies this change.
const mockUseAIChat = jest.fn();
jest.mock("@ai-sdk/react", () => ({
  useChat: (...args: unknown[]) => mockUseAIChat(...args),
}));
jest.mock("ai", () => ({ DefaultChatTransport: class {} }));
jest.mock("@connectrpc/connect-web", () => ({ createConnectTransport: jest.fn(() => ({})) }));

const mockGetHistory = jest.fn();
const mockDeleteConversation = jest.fn();
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    getConversationHistory: (...args: unknown[]) => mockGetHistory(...args),
    deleteConversation: (...args: unknown[]) => mockDeleteConversation(...args),
    listConversations: jest.fn(),
  }),
}));
jest.mock("~/gen/chat/v1/chat_pb", () => ({ ChatService: {} }));

interface AIState {
  messages: unknown[];
  setMessages: jest.Mock;
  sendMessage: jest.Mock;
  regenerate: jest.Mock;
  stop: jest.Mock;
  clearError: jest.Mock;
  status: "ready" | "submitted" | "streaming" | "error";
  error: Error | undefined;
}

let state: AIState;

function aiState(overrides: Partial<AIState> = {}): AIState {
  return {
    messages: [],
    setMessages: jest.fn(),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    regenerate: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    clearError: jest.fn(),
    status: "ready",
    error: undefined,
    ...overrides,
  };
}

/** A stored message as the chat service's GetConversationHistory returns it. */
function storedMessage(id: string, role: number, content: string) {
  return { id, role, content, toolCalls: [], citations: [] };
}

beforeEach(() => {
  jest.clearAllMocks();
  state = aiState();
  mockUseAIChat.mockImplementation(() => state);
  mockGetHistory.mockResolvedValue({ messages: [] });
  mockDeleteConversation.mockResolvedValue({});
});

describe("useChat switching the thread while a reply streams", () => {
  it("New chat stops the reply in flight before it empties the thread", async () => {
    const order: string[] = [];
    state = aiState({
      status: "streaming",
      stop: jest.fn(async () => {
        order.push("stop");
      }),
      setMessages: jest.fn(() => order.push("replace")),
    });
    const { result } = renderHook(() => useChat({ userId: "user-1" }));

    await act(async () => {
      await result.current.clearChat();
    });

    expect(order).toEqual(["stop", "replace"]);
  });

  it("opening a conversation stops the reply in flight before the thread is replaced", async () => {
    const order: string[] = [];
    state = aiState({
      status: "streaming",
      stop: jest.fn(async () => {
        order.push("stop");
      }),
      setMessages: jest.fn(() => order.push("replace")),
    });
    mockGetHistory.mockResolvedValue({
      messages: [storedMessage("m-1", 1, "Earlier question")],
    });
    const { result } = renderHook(() => useChat({ userId: "user-1" }));

    await act(async () => {
      await result.current.loadConversation("conv-b");
    });

    expect(order).toEqual(["stop", "replace"]);
    expect(result.current.conversationId).toBe("conv-b");
  });

  it("deleting the open conversation mid-reply clears it without the deleted id coming back", async () => {
    const order: string[] = [];
    state = aiState({
      status: "streaming",
      stop: jest.fn(async () => {
        order.push("stop");
      }),
      setMessages: jest.fn(() => order.push("replace")),
    });
    mockGetHistory.mockResolvedValue({ messages: [] });
    const { result } = renderHook(() => useChat({ userId: "user-1" }));
    await act(async () => {
      await result.current.loadConversation("conv-a");
    });
    order.length = 0;

    await act(async () => {
      await result.current.deleteConversation("conv-a");
    });

    expect(order).toEqual(["stop", "replace"]);
    expect(result.current.conversationId).toBeNull();
  });

  it("a slower answer for an earlier click cannot replace a conversation opened after it", async () => {
    let resolveA!: (value: unknown) => void;
    mockGetHistory.mockImplementation(({ conversationId }: { conversationId: string }) =>
      conversationId === "conv-a"
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve({ messages: [storedMessage("m-b", 1, "B's question")] }),
    );
    const { result } = renderHook(() => useChat({ userId: "user-1" }));

    let loadA!: Promise<void>;
    await act(async () => {
      loadA = result.current.loadConversation("conv-a");
    });
    await act(async () => {
      await result.current.loadConversation("conv-b");
    });
    await act(async () => {
      resolveA({ messages: [storedMessage("m-a", 1, "A's question")] });
      await loadA;
    });

    const shown = JSON.stringify(state.setMessages.mock.calls.at(-1)?.[0]);
    expect(shown).toContain("B's question");
    expect(shown).not.toContain("A's question");
    expect(result.current.conversationId).toBe("conv-b");
  });

  it("does not send or retry while a conversation is still loading", async () => {
    let resolveHistory!: (value: unknown) => void;
    mockGetHistory.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveHistory = resolve;
        }),
    );
    state = aiState({ messages: [{ id: "m-1", role: "user", parts: [{ type: "text", text: "Q" }] }] });
    const { result } = renderHook(() => useChat({ userId: "user-1" }));

    let load!: Promise<void>;
    await act(async () => {
      load = result.current.loadConversation("conv-a");
    });
    expect(result.current.isLoadingHistory).toBe(true);

    await act(async () => {
      await result.current.sendMessage("a suggestion clicked during the load");
      await result.current.retry();
    });
    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(state.regenerate).not.toHaveBeenCalled();

    await act(async () => {
      resolveHistory({ messages: [] });
      await load;
    });
    await act(async () => {
      await result.current.sendMessage("now it is open");
    });
    expect(state.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("New chat cancels a history load still pending, so it does not reopen the old conversation", async () => {
    let resolveA!: (value: unknown) => void;
    mockGetHistory.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        }),
    );
    const { result } = renderHook(() => useChat({ userId: "user-1" }));

    let loadA!: Promise<void>;
    await act(async () => {
      loadA = result.current.loadConversation("conv-a");
    });
    await act(async () => {
      await result.current.clearChat();
    });
    await act(async () => {
      resolveA({ messages: [storedMessage("m-a", 1, "A's question")] });
      await loadA;
    });

    expect(result.current.conversationId).toBeNull();
    expect(result.current.isLoading).toBe(false);
    const replaced = state.setMessages.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(replaced.some((value) => value.includes("A's question"))).toBe(false);
  });
});
