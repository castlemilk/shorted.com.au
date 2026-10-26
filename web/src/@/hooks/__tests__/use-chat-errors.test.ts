import { act, renderHook } from "@testing-library/react";
import type { UIMessage } from "ai";
import { useChat } from "../use-chat";

// The AI SDK and Connect runtime are ESM-only and do not load under jest. The
// hook's own logic is what is under test: the SDK's state is driven directly.
const mockUseAIChat = jest.fn();

jest.mock("@ai-sdk/react", () => ({
  useChat: (...args: unknown[]) => mockUseAIChat(...args),
}));
jest.mock("ai", () => ({ DefaultChatTransport: class {} }));
jest.mock("@connectrpc/connect-web", () => ({ createConnectTransport: jest.fn() }));
jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn() }));
jest.mock("~/gen/chat/v1/chat_pb", () => ({ ChatService: {} }));

interface AIState {
  messages: UIMessage[];
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

function lastOptions(): { onData: (part: unknown) => void } {
  const call = mockUseAIChat.mock.calls.at(-1) as [{ onData: (part: unknown) => void }];
  return call[0];
}

function contractError(body: Record<string, unknown>): Error {
  return new Error(JSON.stringify(body));
}

beforeEach(() => {
  state = aiState();
  mockUseAIChat.mockReset();
  mockUseAIChat.mockImplementation(() => state);
});

describe("useChat errors from the stream (point 1)", () => {
  it("parses an in-stream rate limit into a typed error, with its window", () => {
    state = aiState({
      status: "error",
      error: contractError({
        error: "rate limited",
        code: "rate_limited",
        message: "Too many messages this minute.",
        limitKind: "per_minute",
        retryAfterSeconds: 30,
      }),
    });

    const { result } = renderHook(() => useChat());

    expect(result.current.error).toEqual({
      code: "rate_limited",
      message: "Too many messages this minute.",
      limitKind: "per_minute",
      retryAfterSeconds: 30,
    });
  });

  it("never exposes the raw contract body as the error message", () => {
    state = aiState({
      status: "error",
      error: contractError({ error: "rate limited", code: "rate_limited" }),
    });

    const { result } = renderHook(() => useChat());

    expect(result.current.error?.code).toBe("rate_limited");
    expect(result.current.error?.message).not.toMatch(/[{}]/);
    expect(JSON.stringify(result.current.error)).not.toContain('"error":');
  });

  it("parses a non-2xx body, whose message is the raw response text", () => {
    state = aiState({
      status: "error",
      error: contractError({
        error: "premium required",
        code: "premium_required",
        message: "Upgrade to use AI chat.",
      }),
    });

    const { result } = renderHook(() => useChat());

    expect(result.current.error?.code).toBe("premium_required");
    expect(result.current.error?.message).toBe("Upgrade to use AI chat.");
  });

  it("classifies the route's plain unavailable text", () => {
    state = aiState({
      status: "error",
      error: new Error("Chat is temporarily unavailable."),
    });

    const { result } = renderHook(() => useChat());

    expect(result.current.error).toEqual({ code: "unavailable", message: "" });
  });

  it("clears the error once the stream error clears", () => {
    state = aiState({
      status: "error",
      error: contractError({ code: "unavailable", message: "Down." }),
    });
    const { result, rerender } = renderHook(() => useChat());
    expect(result.current.error).not.toBeNull();

    state = aiState({ status: "ready", error: undefined });
    rerender();

    expect(result.current.error).toBeNull();
  });
});

describe("useChat errors from a send (point 1)", () => {
  it("parses a rejected send into a typed error", async () => {
    state = aiState({
      sendMessage: jest
        .fn()
        .mockRejectedValue(
          contractError({ code: "unauthenticated", message: "Sign in to continue." }),
        ),
    });
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage("Who is shorted?");
    });

    expect(result.current.error).toEqual({
      code: "unauthenticated",
      message: "Sign in to continue.",
    });
  });

  it("ignores an aborted send rather than showing it", async () => {
    const aborted = new Error("The operation was aborted.");
    aborted.name = "AbortError";
    state = aiState({ sendMessage: jest.fn().mockRejectedValue(aborted) });
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage("Hi");
    });

    expect(result.current.error).toBeNull();
  });
});

describe("useChat conversation id (point 2)", () => {
  it("takes the id from a data-shorted-conversation part as it arrives", () => {
    const { result } = renderHook(() => useChat());
    expect(result.current.conversationId).toBeNull();

    act(() => {
      lastOptions().onData({
        type: "data-shorted-conversation",
        data: { conversationId: "conv-9" },
      });
    });

    expect(result.current.conversationId).toBe("conv-9");
  });

  it("reads the id from a message's parts when no final part has arrived", () => {
    state = aiState({
      status: "streaming",
      messages: [
        {
          id: "u-1",
          role: "user",
          parts: [{ type: "text", text: "Who is shorted?" }],
        } as UIMessage,
        {
          id: "a-1",
          role: "assistant",
          parts: [
            { type: "text", text: "Looking", state: "streaming" },
            { type: "data-shorted-conversation", data: { conversationId: "conv-7" } },
          ],
        } as unknown as UIMessage,
      ],
    });

    const { result } = renderHook(() => useChat());

    expect(result.current.conversationId).toBe("conv-7");
  });

  it("retries a failed reply in the same conversation", async () => {
    state = aiState({
      status: "error",
      error: contractError({ code: "unavailable", message: "" }),
      messages: [
        { id: "u-1", role: "user", parts: [{ type: "text", text: "Q" }] } as UIMessage,
        {
          id: "a-1",
          role: "assistant",
          parts: [{ type: "text", text: "Partial", state: "streaming" }],
        } as UIMessage,
      ],
    });
    const { result } = renderHook(() => useChat());

    act(() => {
      lastOptions().onData({
        type: "data-shorted-conversation",
        data: { conversationId: "conv-9" },
      });
    });
    await act(async () => {
      await result.current.retry();
    });

    expect(state.regenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ conversationId: "conv-9" }),
      }),
    );
  });

  it("sends the next question in the same conversation", async () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      lastOptions().onData({
        type: "data-shorted-conversation",
        data: { conversationId: "conv-9" },
      });
    });
    await act(async () => {
      await result.current.sendMessage("Next question");
    });

    expect(state.sendMessage).toHaveBeenCalledWith(
      { text: "Next question" },
      expect.objectContaining({
        body: expect.objectContaining({ conversationId: "conv-9" }),
      }),
    );
  });

  it("does not retry while a reply is still in flight", async () => {
    state = aiState({
      status: "streaming",
      messages: [{ id: "u-1", role: "user", parts: [{ type: "text", text: "Q" }] } as UIMessage],
    });
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.retry();
    });

    expect(state.regenerate).not.toHaveBeenCalled();
  });
});
