import { NextRequest, NextResponse } from "next/server";
import { maxDuration, POST } from "../route";
import { auth } from "~/server/auth";
import { getSubscriptionStatus } from "~/app/actions/subscription";
import { rateLimit } from "@/lib/rate-limit";
import { streamChatFromUpstream } from "@/lib/chat-upstream-client";
import { parseChatErrorBody } from "@/hooks/chat-ui-message-adapter";

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
  const payload = {
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
  };
  return {
    url: "https://shorted.com.au/api/chat",
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      origin: "https://shorted.com.au",
    }),
    signal: new AbortController().signal,
    json: async () => payload,
  } as unknown as NextRequest;
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

  it("applies isolated per-user minute, daily, and monthly send limits", async () => {
    await POST(request());

    expect(mockRateLimit).toHaveBeenCalledTimes(3);
    expect(mockRateLimit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ url: "https://shorted.com.au/api/chat" }),
      expect.objectContaining({
        bucketName: "chat-send-minute",
        authenticatedLimit: 4,
        windowSeconds: 60,
      }),
    );
    expect(mockRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ url: "https://shorted.com.au/api/chat" }),
      expect.objectContaining({
        bucketName: "chat-send-day",
        authenticatedLimit: 40,
        windowSeconds: 86_400,
      }),
    );
    expect(mockRateLimit).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ url: "https://shorted.com.au/api/chat" }),
      expect.objectContaining({
        bucketName: "chat-send-month",
        authenticatedLimit: 600,
        windowSeconds: 2_592_000,
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

  it("rejects cross-site chat requests before generation", async () => {
    const crossSite = {
      url: "https://shorted.com.au/api/chat",
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        origin: "https://evil.example",
      }),
      signal: new AbortController().signal,
      json: async () => ({
        messages: [
          {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      }),
    } as unknown as NextRequest;

    const response = await POST(crossSite);

    expect(response.status).toBe(403);
    expect(mockStreamChatFromUpstream).not.toHaveBeenCalled();
  });

  it("fails closed in production when the internal chat service URL is missing", async () => {
    delete process.env.CHAT_SERVICE_INTERNAL_URL;
    process.env.NEXT_PUBLIC_CHAT_SERVICE_ENDPOINT = "https://api.shorted.com.au";

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mockStreamChatFromUpstream).not.toHaveBeenCalled();
  });

  it("forwards a regenerate as a retry, so the chat service does not store the question twice", async () => {
    // The upstream call happens while the response streams, so read it through.
    mockStreamChatFromUpstream.mockReturnValueOnce(upstreamChunks());
    await (await POST(request({ trigger: "regenerate-message" }))).text();
    expect(mockStreamChatFromUpstream).toHaveBeenLastCalledWith(
      expect.objectContaining({ retry: true }),
    );

    mockStreamChatFromUpstream.mockReturnValueOnce(upstreamChunks());
    await (await POST(request({ trigger: "submit-message" }))).text();
    expect(mockStreamChatFromUpstream).toHaveBeenLastCalledWith(
      expect.objectContaining({ retry: false }),
    );
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

  describe("message length and rate limits", () => {
    function messageRequest(text: string) {
      return request({
        messages: [
          {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text }],
          },
        ],
      });
    }

    it("rejects a message over 2000 characters before spending a rate-limit token", async () => {
      const response = await POST(messageRequest("a".repeat(2001)));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("2000 characters"),
      });
      expect(mockRateLimit).not.toHaveBeenCalled();
      expect(mockAuth).not.toHaveBeenCalled();
      expect(mockStreamChatFromUpstream).not.toHaveBeenCalled();
    });

    it("counts characters by code point, so a 2000-character message is still accepted", async () => {
      // Each emoji is one character to a user and one code point, but two UTF-16
      // units, so a UTF-16 count would wrongly refuse this message.
      const text = "🙂".repeat(2000);

      const response = await POST(messageRequest(text));

      expect(response.status).toBe(200);
      expect(mockRateLimit).toHaveBeenCalled();
    });

    it("maps a web send-limit refusal onto the contract with the window and wait", async () => {
      mockRateLimit.mockResolvedValueOnce({
        success: false,
        response: NextResponse.json(
          { error: "Rate limit exceeded" },
          { status: 429, headers: { "Retry-After": "42" } },
        ),
      });

      const response = await POST(request());

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("42");
      const body = await response.json();
      expect(body).toMatchObject({
        error: "Rate limit exceeded",
        code: "rate_limited",
        limitKind: "per_minute",
        retryAfterSeconds: 42,
      });
      expect(body.message).toContain("per minute");
      expect(typeof body.resetAt).toBe("number");
      expect(mockStreamChatFromUpstream).not.toHaveBeenCalled();
    });

    it("answers an unauthenticated request with the unauthenticated contract", async () => {
      mockAuth.mockResolvedValue(null);

      const response = await POST(request());

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: "Authentication required",
        code: "unauthenticated",
        message: expect.any(String),
      });
    });

    it("answers a non-premium request with the premium_required contract", async () => {
      mockGetSubscriptionStatus.mockResolvedValue(
        subscription({ hasActiveSubscription: false, isPremium: false }),
      );

      const response = await POST(request());

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: "Premium subscription required",
        code: "premium_required",
      });
    });

    it("answers an unparseable body with the invalid_request contract", async () => {
      const broken = {
        ...request(),
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      } as unknown as NextRequest;

      const response = await POST(broken);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_request",
      });
    });

    it("answers an unconfigured server with the unavailable contract and a retry hint", async () => {
      delete process.env.CHAT_SERVICE_INTERNAL_URL;
      process.env.NEXT_PUBLIC_CHAT_SERVICE_ENDPOINT = "https://api.shorted.com.au";

      const response = await POST(request());

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("60");
      await expect(response.json()).resolves.toMatchObject({
        code: "unavailable",
        retryAfterSeconds: 60,
      });
      delete process.env.NEXT_PUBLIC_CHAT_SERVICE_ENDPOINT;
    });

    it("emits the conversation part before any text, as soon as the upstream names it", async () => {
      const response = await POST(request({ conversationId: "" }));
      const parts = await partsOf(response);

      const conversationAt = parts.findIndex(
        (part) => part.type === "data-shorted-conversation",
      );
      const firstTextAt = parts.findIndex((part) => part.type === "text-delta");
      expect(conversationAt).toBeGreaterThanOrEqual(0);
      expect(conversationAt).toBeLessThan(firstTextAt);
      expect(parts[conversationAt]).toMatchObject({
        data: { conversationId: "conv-final" },
      });
    });

    it("keeps the conversation id when the turn fails before any text, from an id-only frame", async () => {
      // The chat service names the conversation before the model runs, in a
      // frame with no text, so a failure before the first token still has it.
      mockStreamChatFromUpstream.mockReturnValue(
        (async function* () {
          yield { conversationId: "conv-early" };
          throw connectLikeError(14, "model unavailable");
        })(),
      );

      const parts = await partsOf(await POST(request({ conversationId: "" })));

      expect(parts.find((part) => part.type === "data-shorted-conversation")).toMatchObject({
        data: { conversationId: "conv-early" },
      });
      expect(parts.some((part) => part.type === "text-delta")).toBe(false);
      expect(parts.some((part) => part.type === "error")).toBe(true);
    });

    it("keeps the conversation id when the turn fails, so the next send does not fork it", async () => {
      mockStreamChatFromUpstream.mockReturnValue(
        (async function* () {
          yield { conversationId: "conv-kept", chunk: "Partial answer" };
          throw connectLikeError(14, "upstream went away");
        })(),
      );

      const parts = await partsOf(await POST(request({ conversationId: "" })));

      const conversation = parts.find(
        (part) => part.type === "data-shorted-conversation",
      );
      expect(conversation).toMatchObject({
        data: { conversationId: "conv-kept" },
      });
    });

    it("sends a limit refused mid-stream as an in-stream error carrying the contract", async () => {
      mockStreamChatFromUpstream.mockReturnValue(
        (async function* () {
          yield { conversationId: "conv-limited" };
          throw connectLikeError(8, "limit reached", {
            "x-chat-limit": JSON.stringify({
              kind: "daily",
              limit: 40,
              retry_after_seconds: 3600,
              reset_at: 1_800_000_000,
            }),
          });
        })(),
      );

      const parts = await partsOf(await POST(request()));

      const errorPart = parts.find((part) => part.type === "error");
      expect(errorPart).toBeDefined();
      expect(parseChatErrorBody(errorPart?.errorText as string)).toEqual({
        error: "Rate limit exceeded",
        code: "rate_limited",
        message:
          "You have reached the limit of 40 messages in 24 hours. Try again in 60 minutes.",
        retryAfterSeconds: 3600,
        limitKind: "daily",
        resetAt: 1_800_000_000,
      });
      // The text part is closed before the error, and no final data follows it.
      const textEndAt = parts.findIndex((part) => part.type === "text-end");
      expect(textEndAt).toBeLessThan(parts.indexOf(errorPart!));
      expect(parts.some((part) => part.type === "data-shorted-final")).toBe(false);
    });

    it("sends any other mid-stream failure as an unavailable contract", async () => {
      mockStreamChatFromUpstream.mockReturnValue(
        (async function* () {
          throw connectLikeError(13, "boom");
        })(),
      );

      const parts = await partsOf(await POST(request()));

      const errorPart = parts.find((part) => part.type === "error");
      expect(parseChatErrorBody(errorPart?.errorText as string)).toMatchObject({
        code: "unavailable",
        message: "Chat is temporarily unavailable.",
      });
    });

    it("declares a 60 second duration, so tool-heavy turns are not cut at 15 seconds", () => {
      expect(maxDuration).toBe(60);
    });
  });
});

type StreamPart = { type: string; [key: string]: unknown };

async function partsOf(response: Response): Promise<StreamPart[]> {
  const raw = await response.text();
  return raw
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as StreamPart);
}

/** An error shaped the way Connect's ConnectError is, read by duck typing. */
function connectLikeError(
  code: number,
  message: string,
  metadata: Record<string, string> = {},
): Error {
  return Object.assign(new Error(message), {
    code,
    metadata: new Headers(metadata),
  });
}
