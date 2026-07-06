"use client";

import { ChatMessageBubble } from "~/@/components/chat/chat-message";
import type { ChatMessage } from "~/@/hooks/use-chat";

const stockDetailsToolCall: NonNullable<ChatMessage["toolCalls"]>[number] = {
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
};

const shortInterestToolCall: NonNullable<ChatMessage["toolCalls"]>[number] = {
  toolName: "query_short_positions",
  arguments: JSON.stringify({ stock_code: "ZIP", period: "1m" }),
  result: JSON.stringify({
    timeSeries: [
      {
        productCode: "ZIP",
        name: "ZIP Co Limited",
        latestShortPosition: 6.42,
        points: [
          { timestamp: "2026-06-01T00:00:00Z", shortPosition: 4.8 },
          { timestamp: "2026-06-15T00:00:00Z", shortPosition: 5.7 },
          { timestamp: "2026-07-01T00:00:00Z", shortPosition: 6.42 },
        ],
      },
    ],
  }),
};

const message: ChatMessage = {
  id: "e2e-assistant-message",
  role: "assistant",
  content:
    "### ZIP short interest\n\n| Metric | Value |\n| --- | --- |\n| Latest short interest | 6.42% |\n| One month change | +1.62 pts |\n\nThis table should render as markdown, followed by rich tool result cards.",
  toolCalls: [stockDetailsToolCall, shortInterestToolCall],
  citations: [
    {
      sourceType: "asx_announcement",
      reference: "ZIP 2026-07-06",
      url: "https://example.com/zip.pdf",
    },
  ],
  createdAt: new Date("2026-07-06T00:00:00.000Z"),
};

export function ChatRenderSmokeClient() {
  return (
    <main
      data-testid="chat-render-smoke"
      className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 bg-background p-6 text-foreground"
    >
      <ChatMessageBubble message={message} />
    </main>
  );
}
