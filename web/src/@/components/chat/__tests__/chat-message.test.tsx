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
