import { readFileSync } from "fs";
import { join } from "path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ChatMessageBubble } from "../chat-message";
import type { ChatMessage } from "~/@/hooks/use-chat";

jest.mock("../chat-markdown", () => ({
  ChatMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

jest.mock("lucide-react", () => {
  const Icon = ({ className }: { className?: string }) => (
    <svg className={className} aria-hidden="true" />
  );
  return {
    Bot: Icon,
    User: Icon,
    Wrench: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    ExternalLink: Icon,
    Loader2: Icon,
    Link2: Icon,
    Activity: Icon,
    ArrowUpRight: Icon,
    BarChart3: Icon,
    Building2: Icon,
  };
});

function assistantMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-1",
    role: "assistant",
    content: "Here is the latest context.",
    createdAt: new Date("2026-07-06T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ChatMessageBubble rich tool rendering", () => {
  it("renders stock details tool output as a stock card instead of raw JSON", () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          toolCalls: [
            {
              toolName: "get_stock_details",
              arguments: JSON.stringify({ stock_code: "ZIP" }),
              result: JSON.stringify({
                stock: {
                  productCode: "ZIP",
                  companyName: "ZIP Co Limited",
                  industry: "Consumer Finance",
                  summary: "Buy now, pay later platform.",
                  website: "https://zip.co",
                  percentageShorted: 6.42,
                },
              }),
            },
          ],
        })}
      />,
    );

    expect(screen.getByTestId("chat-stock-card")).toBeInTheDocument();
    expect(screen.getByText("ZIP")).toBeInTheDocument();
    expect(screen.getByText("ZIP Co Limited")).toBeInTheDocument();
    expect(screen.getByText("6.42% shorted")).toBeInTheDocument();
    expect(screen.queryByText(/"productCode"/)).not.toBeInTheDocument();
  });

  it("renders short-position time series tool output as a compact chart", async () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          toolCalls: [
            {
              toolName: "query_short_positions",
              arguments: JSON.stringify({ stock_code: "PLS", period: "1m" }),
              result: JSON.stringify({
                timeSeries: [
                  {
                    productCode: "PLS",
                    name: "Pilbara Minerals",
                    latestShortPosition: 8.9,
                    points: [
                      { timestamp: "2026-06-01T00:00:00Z", shortPosition: 6.1 },
                      { timestamp: "2026-06-15T00:00:00Z", shortPosition: 7.4 },
                      { timestamp: "2026-07-01T00:00:00Z", shortPosition: 8.9 },
                    ],
                  },
                ],
              }),
            },
          ],
        })}
      />,
    );

    expect(screen.getByTestId("chat-short-chart")).toBeInTheDocument();
    expect(screen.getByText("PLS short interest")).toBeInTheDocument();
    expect(screen.getByText("8.90% latest")).toBeInTheDocument();
    expect(screen.queryByText(/"shortPosition"/)).not.toBeInTheDocument();
    // The interactive chart is loaded on demand: wait for it, so the load finishes inside the test.
    expect(
      await screen.findByRole("group", { name: /PLS short interest/ }),
    ).toBeInTheDocument();
  });

  it("opens a rich result by default, inside the tool", () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          toolCalls: [
            {
              toolName: "get_stock_details",
              arguments: "{}",
              result: JSON.stringify({ stock: { productCode: "ZIP", companyName: "ZIP Co" } }),
            },
          ],
        })}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Stock details/ });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("chat-stock-card")).toBeInTheDocument();
  });

  it("keeps the message when a timestamp is outside the Date range, and draws no chart", () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          content: "The short position fell.",
          toolCalls: [
            {
              toolName: "query_short_positions",
              arguments: JSON.stringify({ stock_code: "BHP", period: "1m" }),
              result: JSON.stringify({
                productCode: "BHP",
                points: [
                  { timestamp: { seconds: 1e17 }, shortPosition: 1.2 },
                  { timestamp: "2026-10-01T00:00:00Z", shortPosition: 1.5 },
                ],
              }),
            },
          ],
        })}
      />,
    );

    // The out-of-range reading is dropped, and one reading left is not a line.
    expect(screen.queryByTestId("chat-short-chart")).not.toBeInTheDocument();
    expect(screen.getByText("The short position fell.")).toBeInTheDocument();
  });
});

/**
 * A tool result's website and a citation's URL come from stored data and the
 * model, and were rendered as hrefs as they came: a `javascript:` URL ran in
 * our origin when clicked (security review SEC-07). Only http(s) is a link.
 */
describe("ChatMessageBubble links from data", () => {
  function stockCard(website: string) {
    return assistantMessage({
      toolCalls: [
        {
          toolName: "get_stock_details",
          arguments: JSON.stringify({ stock_code: "ZIP" }),
          result: JSON.stringify({
            stock: { productCode: "ZIP", companyName: "ZIP Co Limited", website },
          }),
        },
      ],
    });
  }

  it("links an http(s) company site", () => {
    render(<ChatMessageBubble message={stockCard("https://zip.co")} />);

    expect(screen.getByRole("link", { name: "Company site" })).toHaveAttribute(
      "href",
      "https://zip.co",
    );
  });

  it.each([["javascript:alert(document.cookie)"], [" data:text/html,<b>x</b>"], ["//evil.example"]])(
    "shows the company site %p as text, not a link",
    (website) => {
      const { container } = render(<ChatMessageBubble message={stockCard(website)} />);

      expect(screen.getByText(website.trim())).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Company site" })).not.toBeInTheDocument();
      expect(container.querySelector("a")).toBeNull();
    },
  );

  it("links only the http(s) citations", () => {
    const { container } = render(
      <ChatMessageBubble
        message={assistantMessage({
          citations: [
            { sourceType: "news", reference: "AFR", url: "https://www.afr.com/x" },
            { sourceType: "news", reference: "Injected", url: "javascript:alert(1)" },
            { sourceType: "asx", reference: "Notice", url: "  vbscript:msgbox(1)" },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "3 sources" }));

    expect(screen.getByText("Injected")).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual([
      "https://www.afr.com/x",
    ]);
  });
});

describe("ChatMessageBubble sources", () => {
  it("collapses citations behind a count and opens them as links", () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          citations: [
            { sourceType: "asx_announcement", reference: "ZIP 2026-07-06", url: "https://example.com/zip.pdf" },
          ],
        })}
      />,
    );

    const trigger = screen.getByRole("button", { name: "1 source" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("ZIP 2026-07-06")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    const link = screen.getByRole("link", { name: /ZIP 2026-07-06/ });
    expect(link).toHaveAttribute("href", "https://example.com/zip.pdf");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(link).getByText("asx_announcement")).toBeInTheDocument();
  });

  it("falls back to the source type when a citation has no reference", () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          citations: [{ sourceType: "news", reference: "", url: "https://www.afr.com/x" }],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "1 source" }));

    expect(screen.getByRole("link", { name: /^news/ })).toBeInTheDocument();
  });
});

describe("ChatMessageBubble tool calls", () => {
  it("collapses an ordinary tool call and shows its arguments and result when opened", () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          toolCalls: [
            {
              toolName: "search_stocks",
              arguments: JSON.stringify({ query: "zip" }),
              result: JSON.stringify({ hits: 3 }),
            },
          ],
        })}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Search stocks/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(screen.getByText("Arguments")).toBeInTheDocument();
    expect(screen.getByText(/"query": "zip"/)).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
  });

  it("marks a tool that reported an error as failed and shows its message, not the JSON", () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          toolCalls: [
            {
              toolName: "get_news",
              arguments: "{}",
              result: JSON.stringify({ error: "News feed is unavailable" }),
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Get news/ }));

    expect(screen.getByText("News feed is unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/"error"/)).not.toBeInTheDocument();
  });

  it("marks a tool the chat service recorded as failed, with its text and body hidden", () => {
    // The shape the chat service stores for a failed call: "Error: " and the
    // failure, which carries the upstream response body.
    render(
      <ChatMessageBubble
        message={assistantMessage({
          toolCalls: [
            {
              toolName: "get_stock_details",
              arguments: JSON.stringify({ stock_code: "ZIP" }),
              result:
                'Error: RPC GetStockDetails returned 404: {"code":"not_found","message":"no stock ZIPX"}',
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Stock details/ }));

    expect(screen.getByText("This data could not be retrieved.")).toBeInTheDocument();
    expect(screen.queryByText(/not_found/)).not.toBeInTheDocument();
    expect(screen.queryByText(/RPC GetStockDetails/)).not.toBeInTheDocument();
  });
});

describe("ChatMessageBubble streaming state", () => {
  it("shows the thinking indicator while the active reply has no text yet", () => {
    render(
      <ChatMessageBubble
        isActive
        message={assistantMessage({ content: "", isStreaming: true })}
      />,
    );

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("shows the caret only while the active reply is streaming", () => {
    const { container, rerender } = render(
      <ChatMessageBubble
        isActive
        message={assistantMessage({ content: "Partial", isStreaming: true })}
      />,
    );
    expect(container.querySelector("span.inline-block.h-4")).not.toBeNull();

    rerender(
      <ChatMessageBubble
        message={assistantMessage({ content: "Partial", isStreaming: true })}
      />,
    );
    expect(container.querySelector("span.inline-block.h-4")).toBeNull();
  });

  it("leaves no spinner or caret after a failed reply, even though its part still reads streaming", () => {
    const { container } = render(
      <ChatMessageBubble
        isActive={false}
        message={assistantMessage({ content: "", isStreaming: true })}
      />,
    );

    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(container.querySelector("span.inline-block.h-4")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("keeps a failed reply's partial text but drops its caret", () => {
    const { container } = render(
      <ChatMessageBubble
        isActive={false}
        message={assistantMessage({ content: "Half an answer", isStreaming: true })}
      />,
    );

    expect(screen.getByText("Half an answer")).toBeInTheDocument();
    expect(container.querySelector("span.inline-block.h-4")).toBeNull();
  });
});

/** A recorded result string, exactly as the chat service returned it. */
function recorded(name: string): string {
  return readFileSync(
    join(__dirname, "..", "__fixtures__", "tool-results", name),
    "utf8",
  );
}

describe("ChatMessageBubble tables from tool results", () => {
  it("renders the most-shorted answer as a table, open by default", async () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          toolCalls: [
            {
              toolName: "get_top_shorts",
              arguments: JSON.stringify({ limit: 10 }),
              result: recorded("get_top_shorts-10.json"),
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("button", { name: /Top shorts/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("table", { name: "Most shorted ASX stocks" })).toBeInTheDocument();
    expect(screen.queryByText(/"productCode"/)).not.toBeInTheDocument();
    await screen.findAllByRole("group", { name: /short interest/ });
  });

  it("draws each economic series as its own interactive chart", async () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          toolCalls: [
            {
              toolName: "get_economic_series",
              arguments: JSON.stringify({ series_keys: ["rates.cash_rate_target.aus"] }),
              result: recorded("get_economic_series-cash-rate-cpi.json"),
            },
          ],
        })}
      />,
    );

    const figures = screen.getAllByTestId("chat-economic-chart");
    expect(figures).toHaveLength(2);
    expect(screen.getByText("Rates · Cash rate target · Australia")).toBeInTheDocument();
    expect(screen.getByText("CPI · Annual change · Australia")).toBeInTheDocument();
    expect(screen.getByText(/^First 3\.60% on 1 Sep 2025/)).toBeInTheDocument();
    await screen.findAllByRole("group", { name: /Rates · Cash rate target/ });
  });

  it("renders the empty director-trades answer as a sentence", () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          toolCalls: [
            {
              toolName: "get_director_trades",
              arguments: JSON.stringify({ stock_code: "GLC" }),
              result: recorded("get_director_trades-glc-none.json"),
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("No director trades reported for GLC.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Director trades/ })).toBeInTheDocument();
  });

  it("shows a failed call as a failure, not as an empty table", () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          toolCalls: [
            {
              toolName: "get_top_shorts",
              arguments: "{}",
              result: JSON.stringify({ error: "no trades for that code" }),
            },
          ],
        })}
      />,
    );

    // A failed call is not drawn, so it starts collapsed: open it to read what it says.
    fireEvent.click(screen.getByRole("button", { name: /Top shorts/ }));

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("no trades for that code")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("keeps the raw text for a result it cannot read", () => {
    render(
      <ChatMessageBubble
        message={assistantMessage({
          toolCalls: [
            {
              toolName: "get_peer_comparison",
              arguments: "{}",
              result: JSON.stringify({ peers: "not a list" }),
            },
          ],
        })}
      />,
    );

    // Not drawn, so it starts collapsed; open it to read the raw text.
    fireEvent.click(screen.getByRole("button", { name: /Peer comparison/ }));

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(/"peers":"not a list"/)).toBeInTheDocument();
  });
});
