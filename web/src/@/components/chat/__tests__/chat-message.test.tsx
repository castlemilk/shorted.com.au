import { render, screen } from "@testing-library/react";
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

  it("renders short-position time series tool output as a compact chart", () => {
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

    expect(screen.getByText("Injected")).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual([
      "https://www.afr.com/x",
    ]);
  });
});
