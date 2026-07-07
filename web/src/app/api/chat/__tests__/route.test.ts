import { NextRequest, NextResponse } from "next/server";
import { POST } from "../route";
import { auth } from "~/server/auth";
import { getSubscriptionStatus } from "~/app/actions/subscription";
import { rateLimit } from "@/lib/rate-limit";
import { streamChatFromUpstream } from "@/lib/chat-upstream-client";

jest.mock("ai", () => ({
  createUIMessageStream: jest.fn((options) => options),
  createUIMessageStreamResponse: jest.fn(({ stream, headers }) => {
    return {
      status: 200,
      headers: new Headers({
        "content-type": "text/event-stream",
        ...headers,
      }),
      async text() {
        const chunks: string[] = [];
        const writer = {
          write(part: unknown) {
            chunks.push(`data: ${JSON.stringify(part)}\n\n`);
          },
        };
        await stream.execute({ writer });
        return chunks.join("");
      },
    };
  }),
}));

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("~/app/actions/subscription", () => ({
  getSubscriptionStatus: jest.fn(),
}));

jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn(),
}));

jest.mock("@/lib/chat-upstream-client", () => ({
  streamChatFromUpstream: jest.fn(),
}));

const mockAuth = auth as jest.MockedFunction<typeof auth>;
const mockGetSubscriptionStatus =
  getSubscriptionStatus as jest.MockedFunction<typeof getSubscriptionStatus>;
const mockRateLimit = rateLimit as jest.MockedFunction<typeof rateLimit>;
const mockStreamChatFromUpstream =
  streamChatFromUpstream as jest.MockedFunction<typeof streamChatFromUpstream>;
type SubscriptionInfo = Awaited<ReturnType<typeof getSubscriptionStatus>>;

function subscription(
  overrides: Partial<SubscriptionInfo> = {},
): SubscriptionInfo {
  return {
    status: "active",
    tier: "premium",
    hasActiveSubscription: true,
    isPremium: true,
    canMintTokens: true,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    features: [],
    requestsPerDay: 0,
    ...overrides,
  };
}

function request(body: Record<string, unknown> = {}) {
  return new NextRequest("https://shorted.com.au/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: "conv-existing",
      contextStockCode: "ZIP",
      messages: [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Show me ZIP short interest" }],
        },
      ],
      ...body,
    }),
  });
}

async function* upstreamChunks() {
  yield {
    conversationId: "conv-final",
    chunk:
      "Here is **ZIP**.\n\n| Metric | Value |\n| --- | --- |\n| Short | 6.42% |",
  };
  yield {
    conversationId: "conv-final",
    isComplete: true,
    toolCalls: [
      {
        toolName: "get_stock_details",
        arguments: JSON.stringify({ stock_code: "ZIP" }),
        result: JSON.stringify({ stock: { productCode: "ZIP" } }),
      },
    ],
    citations: [
      {
        sourceType: "asx_announcement",
        reference: "ZIP 2026-07-06",
        url: "https://example.com/zip.pdf",
      },
    ],
  };
}

describe("AI SDK chat route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INTERNAL_SERVICE_SECRET = "server-secret";
    process.env.CHAT_SERVICE_INTERNAL_URL = "https://chat-service.example";
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "production";
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
      expires: "2099-01-01T00:00:00.000Z",
    });
    mockGetSubscriptionStatus.mockResolvedValue(subscription());
    mockRateLimit.mockResolvedValue({ success: true });
    mockStreamChatFromUpstream.mockReturnValue(upstreamChunks());
  });

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    delete process.env.CHAT_SERVICE_INTERNAL_URL;
    delete process.env.VERCEL_ENV;
  });

  it("rejects unauthenticated chat requests before generation", async () => {
    mockAuth.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mockStreamChatFromUpstream).not.toHaveBeenCalled();
  });

  it("rejects users without a valid paid chat entitlement", async () => {
    mockGetSubscriptionStatus.mockResolvedValue(
      subscription({
        status: "canceled",
        tier: "premium",
        hasActiveSubscription: false,
        isPremium: true,
      }),
    );

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mockStreamChatFromUpstream).not.toHaveBeenCalled();
  });

  it("applies per-user minute and daily send limits", async () => {
    await POST(request());

    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRateLimit).toHaveBeenNthCalledWith(
      1,
      expect.any(NextRequest),
      expect.objectContaining({
        authenticatedLimit: 4,
        windowSeconds: 60,
      }),
    );
    expect(mockRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.any(NextRequest),
      expect.objectContaining({
        authenticatedLimit: 40,
        windowSeconds: 86_400,
      }),
    );
  });

  it("does not generate when a send limit is exceeded", async () => {
    mockRateLimit.mockResolvedValueOnce({
      success: false,
      response: NextResponse.json({ error: "rate limited" }, { status: 429 }),
    });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(mockStreamChatFromUpstream).not.toHaveBeenCalled();
  });

  it("streams markdown text and final Shorted data through AI SDK UI message chunks", async () => {
    const response = await POST(request());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(mockStreamChatFromUpstream).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-existing",
        contextStockCode: "ZIP",
        message: "Show me ZIP short interest",
        userID: "user-1",
        userEmail: "user@example.com",
        internalSecret: "server-secret",
      }),
    );
    expect(body).toContain("Here is **ZIP**");
    expect(body).toContain("data-shorted-final");
    expect(body).toContain("conv-final");
    expect(body).toContain("get_stock_details");
    expect(body).toContain("ZIP 2026-07-06");
  });
});
