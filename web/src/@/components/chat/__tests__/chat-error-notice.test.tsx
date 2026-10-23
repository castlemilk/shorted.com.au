import { fireEvent, render, screen } from "@testing-library/react";
import { ChatErrorNotice } from "../chat-error-notice";
import { parseChatError, type ChatErrorInfo } from "~/@/lib/chat-errors";

let mockPathname = "/chat";

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

jest.mock("lucide-react", () => ({}));

function contract(body: Record<string, unknown>): ChatErrorInfo {
  return parseChatError(new Error(JSON.stringify(body)));
}

describe("ChatErrorNotice", () => {
  beforeEach(() => {
    mockPathname = "/chat";
  });

  it("names the minute window and when it resets, and offers no retry", () => {
    render(
      <ChatErrorNotice
        error={contract({
          error: "rate limited",
          code: "rate_limited",
          message: "Slow down.",
          limitKind: "per_minute",
          retryAfterSeconds: 45,
        })}
        onRetry={jest.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "You've reached your chat limit for this minute",
    );
    expect(screen.getByText("Try again in 45 seconds.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it.each([
    [{ limitKind: "daily" }, "You've reached your chat limit for today"],
    [{ limitKind: "monthly" }, "You've reached your chat limit for this month"],
    [{ limitKind: "global" }, "Chat is busy right now"],
    [{}, "You've reached your chat limit"],
  ])("names the rate-limit window %j", (fields, title) => {
    render(<ChatErrorNotice error={contract({ code: "rate_limited", ...fields })} />);

    expect(screen.getByRole("alert")).toHaveTextContent(title);
  });

  it("links premium users to pricing", () => {
    render(<ChatErrorNotice error={contract({ code: "premium_required", message: "" })} />);

    expect(screen.getByText("AI chat is a premium feature")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See plans" })).toHaveAttribute(
      "href",
      "/pricing",
    );
  });

  it("sends signed-out users to sign in and back to the current page", () => {
    mockPathname = "/shorts/BHP";
    render(<ChatErrorNotice error={contract({ code: "unauthenticated", message: "" })} />);

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/signin?callbackUrl=%2Fshorts%2FBHP",
    );
  });

  it("offers Try again for an unavailable service and calls onRetry", () => {
    const onRetry = jest.fn();
    render(
      <ChatErrorNotice
        error={contract({ code: "unavailable", message: "Down for maintenance." })}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("Shorted AI is temporarily unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows an invalid request's message", () => {
    render(
      <ChatErrorNotice
        error={contract({ code: "invalid_request", message: "Message is too long." })}
      />,
    );

    expect(screen.getByText("Message is too long.")).toBeInTheDocument();
  });

  it("offers a new chat for a refused send in a conversation the service no longer has", () => {
    const onNewChat = jest.fn();
    render(
      <ChatErrorNotice
        error={contract({
          error: "Conversation not found",
          code: "invalid_request",
          message: "This conversation is no longer available. Start a new chat.",
        })}
        onNewChat={onNewChat}
      />,
    );

    expect(screen.getByText("This conversation is no longer available. Start a new chat.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("offers no new chat when there is no conversation to leave", () => {
    render(
      <ChatErrorNotice error={contract({ code: "invalid_request", message: "Message is too long." })} />,
    );

    expect(screen.queryByRole("button", { name: "Start a new chat" })).not.toBeInTheDocument();
  });

  it.each([
    [{ code: "rate_limited", limitKind: "per_minute", retryAfterSeconds: 3, message: "" }],
    [{ code: "premium_required", message: "" }],
    [{ code: "unauthenticated", message: "" }],
    [{ code: "invalid_request", message: "" }],
    [{ code: "unavailable", message: "" }],
    [{ error: "Rate limit exceeded" }],
  ])("never shows the raw contract for %j", (body) => {
    const { container } = render(
      <ChatErrorNotice error={contract(body)} onRetry={jest.fn()} />,
    );

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[{}]/);
    expect(text).not.toMatch(/"code"|"error"|"message"/);
  });

  it("renders a legacy plain-text failure as the generic unavailable copy", () => {
    render(<ChatErrorNotice error={parseChatError(new Error("<!DOCTYPE html><html></html>"))} />);

    expect(screen.getByText("Shorted AI is temporarily unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/DOCTYPE/)).not.toBeInTheDocument();
  });
});
