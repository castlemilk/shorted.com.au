import { fireEvent, render, screen, within } from "@testing-library/react";
import { ChatThread } from "../chat-thread";
import type { ChatMessage } from "~/@/hooks/use-chat";
import { parseChatError, type ChatErrorInfo } from "~/@/lib/chat-errors";

// The real loader defers the bubble to a chunk. In tests it renders in place,
// so the thread's behaviour is what is under test.
jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () =>
    function DynamicChatMessageBubble(props: Record<string, unknown>) {
      const { ChatMessageBubble } = jest.requireActual<
        typeof import("../chat-message")
      >("../chat-message");
      return <ChatMessageBubble {...(props as Parameters<typeof ChatMessageBubble>[0])} />;
    },
}));

jest.mock("../chat-markdown", () => ({
  ChatMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

let mockPathname = "/chat";
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

jest.mock("lucide-react", () => {
  const Icon = ({ className }: { className?: string }) => (
    <svg className={className} aria-hidden="true" />
  );
  return {
    ArrowDown: Icon,
    ArrowUpRight: Icon,
    Activity: Icon,
    BarChart3: Icon,
    Bot: Icon,
    Building2: Icon,
    ChevronDown: Icon,
    ExternalLink: Icon,
    Link2: Icon,
    Loader2: Icon,
    MessageSquare: Icon,
    User: Icon,
    Wrench: Icon,
  };
});

const CREATED = new Date("2026-10-23T00:00:00.000Z");

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m-1",
    role: "user",
    content: "Question",
    createdAt: CREATED,
    ...overrides,
  };
}

describe("ChatThread while a conversation opens", () => {
  it("holds the suggestions until the conversation is open", () => {
    const { rerender, props } = renderThread({ messages: [], loadingHistory: true });
    const suggestions = screen.getAllByRole("button").filter((button) =>
      button.textContent?.includes("?"),
    );
    expect(suggestions.length).toBeGreaterThan(0);
    suggestions.forEach((button) => expect(button).toBeDisabled());

    rerender(<ChatThread {...props} loadingHistory={false} />);
    screen
      .getAllByRole("button")
      .filter((button) => button.textContent?.includes("?"))
      .forEach((button) => expect(button).toBeEnabled());
  });
});

describe("ChatThread follows a request it sends", () => {
  it("brings the newest turn into view when a request is submitted, after the reader scrolled up", () => {
    const { rerender, props } = renderThread({
      messages: [message({ id: "u-1", role: "user", content: "First" })],
      status: "ready",
    });
    const log = screen.getByRole("log");
    // jsdom has no layout: the reader is up, the thread is 1000px tall.
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(log, "scrollTop", { configurable: true, writable: true, value: 100 });

    rerender(
      <ChatThread
        {...props}
        status="submitted"
        messages={[
          message({ id: "u-1", role: "user", content: "First" }),
          message({ id: "u-2", role: "user", content: "Follow-up" }),
        ]}
      />,
    );

    expect(log.scrollTop).toBe(1000);
  });
});

describe("ChatThread interrupted reply", () => {
  it("says a reply stopped before it finished, and offers Try again, when it still reads streaming", () => {
    const onRetry = jest.fn();
    renderThread({
      messages: [
        message({ id: "u-1", role: "user", content: "Why?" }),
        message({ id: "a-1", role: "assistant", content: "Partly", isStreaming: true }),
      ],
      status: "ready",
      onRetry,
    });

    expect(screen.getByText("This reply stopped before it finished.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("does not claim a stop while the reply is still arriving", () => {
    renderThread({
      messages: [
        message({ id: "u-1", role: "user", content: "Why?" }),
        message({ id: "a-1", role: "assistant", content: "Partly", isStreaming: true }),
      ],
      status: "streaming",
    });

    expect(screen.queryByText("This reply stopped before it finished.")).not.toBeInTheDocument();
  });

  it("leaves a failed reply to its error notice, and a finished reply alone", () => {
    renderThread({
      messages: [
        message({ id: "u-1", role: "user", content: "Why?" }),
        message({ id: "a-1", role: "assistant", content: "Partly", isStreaming: true }),
      ],
      status: "ready",
      error: errorFrom({ error: "Chat unavailable", code: "unavailable", message: "Chat is temporarily unavailable." }),
    });
    expect(screen.queryByText("This reply stopped before it finished.")).not.toBeInTheDocument();

    renderThread({
      messages: [
        message({ id: "u-2", role: "user", content: "Why?" }),
        message({ id: "a-2", role: "assistant", content: "Done", isStreaming: false }),
      ],
      status: "ready",
    });
    expect(screen.queryByText("This reply stopped before it finished.")).not.toBeInTheDocument();
  });
});

function errorFrom(body: Record<string, unknown>): ChatErrorInfo {
  return parseChatError(new Error(JSON.stringify(body)));
}

type ThreadProps = React.ComponentProps<typeof ChatThread>;

function renderThread(overrides: Partial<ThreadProps> = {}) {
  const props: ThreadProps = {
    messages: [],
    status: "ready",
    error: null,
    historyError: null,
    onRetry: jest.fn(),
    onSuggest: jest.fn(),
    variant: "page",
    ...overrides,
  };
  return { ...render(<ChatThread {...props} />), props };
}

describe("ChatThread empty state", () => {
  beforeEach(() => {
    mockPathname = "/chat";
  });

  it("offers suggestion chips and sends the chosen one", () => {
    const { props } = renderThread();

    fireEvent.click(
      screen.getByRole("button", { name: "What are the most shorted stocks right now?" }),
    );

    expect(props.onSuggest).toHaveBeenCalledWith(
      "What are the most shorted stocks right now?",
    );
  });

  it("offers the stock's own suggestions when a stock is in context", () => {
    renderThread({ stockCode: "ZIP", variant: "sheet" });

    expect(
      screen.getByRole("button", { name: "What's the current short position on ZIP?" }),
    ).toBeInTheDocument();
  });
});

describe("ChatThread live region", () => {
  it("is a polite log that is busy while a reply streams", () => {
    renderThread({
      messages: [message({ id: "u", content: "Hi" }), message({ id: "a", role: "assistant", content: "Ha", isStreaming: true })],
      status: "streaming",
    });

    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAttribute("aria-busy", "true");
  });

  it("is not busy once the reply is done", () => {
    renderThread({
      messages: [message({ id: "u", content: "Hi" }), message({ id: "a", role: "assistant", content: "Hello" })],
      status: "ready",
    });

    expect(screen.getByRole("log")).toHaveAttribute("aria-busy", "false");
  });
});

describe("ChatThread while a reply is awaited", () => {
  it("shows the thinking indicator after a question with no reply yet", () => {
    renderThread({
      messages: [message({ id: "u", content: "Who is shorted?" })],
      status: "submitted",
    });

    expect(screen.getByRole("status")).toHaveTextContent("Thinking...");
  });

  it("shows the caret, not a second indicator, once the reply is streaming", () => {
    renderThread({
      messages: [
        message({ id: "u", content: "Who?" }),
        message({ id: "a", role: "assistant", content: "ZIP", isStreaming: true }),
      ],
      status: "streaming",
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("ZIP")).toBeInTheDocument();
  });
});

describe("ChatThread after a failure", () => {
  it("leaves no spinner behind and shows the error with a retry", () => {
    const onRetry = jest.fn();
    const { container } = renderThread({
      messages: [
        message({ id: "u", content: "Who?" }),
        message({ id: "a", role: "assistant", content: "", isStreaming: true }),
      ],
      status: "error",
      error: errorFrom({ code: "unavailable", message: "Upstream timed out." }),
      onRetry,
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.querySelector("span.inline-block.h-4")).toBeNull();

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Shorted AI is temporarily unavailable")).toBeInTheDocument();
    expect(alert.textContent).not.toMatch(/[{}]/);

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps the partial reply and the notice together", () => {
    renderThread({
      messages: [
        message({ id: "u", content: "Who?" }),
        message({ id: "a", role: "assistant", content: "Half an answer", isStreaming: true }),
      ],
      status: "error",
      error: errorFrom({ code: "unavailable", message: "" }),
    });

    expect(screen.getByText("Half an answer")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("names a rate limit without offering a retry that would fail again", () => {
    renderThread({
      messages: [message({ id: "u", content: "Who?" })],
      status: "error",
      error: errorFrom({
        error: "rate limited",
        code: "rate_limited",
        message: "",
        limitKind: "per_minute",
        retryAfterSeconds: 12,
      }),
      onRetry: jest.fn(),
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "You've reached your chat limit for this minute",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("shows a history load failure as plain text", () => {
    renderThread({
      historyError: "Couldn't load that conversation. Please try again.",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load that conversation. Please try again.",
    );
  });
});

describe("ChatThread message rendering", () => {
  it("renders tools and sources inside the active assistant turn", () => {
    renderThread({
      messages: [
        message({ id: "u", content: "ZIP?" }),
        message({
          id: "a",
          role: "assistant",
          content: "Answer",
          citations: [{ sourceType: "news", reference: "AFR", url: "https://www.afr.com/x" }],
          toolCalls: [{ toolName: "search_stocks", arguments: "{}", result: "{}" }],
        }),
      ],
      status: "ready",
    });

    expect(screen.getByRole("button", { name: "1 source" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Search stocks/ })).toBeInTheDocument();
  });
});
