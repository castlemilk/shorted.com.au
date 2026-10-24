import { NextRequest, NextResponse } from "next/server";
import { POST } from "../route";
import { auth } from "~/server/auth";
import { getSubscriptionStatus } from "~/app/actions/subscription";
import { rateLimit } from "@/lib/rate-limit";

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("~/app/actions/subscription", () => ({
  getSubscriptionStatus: jest.fn(),
}));

jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn(),
}));

const mockAuth = auth as jest.MockedFunction<typeof auth>;
const mockGetSubscriptionStatus =
  getSubscriptionStatus as jest.MockedFunction<typeof getSubscriptionStatus>;
const mockRateLimit = rateLimit as jest.MockedFunction<typeof rateLimit>;
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

function requestFor(method: string, headers: Record<string, string> = {}) {
  const requestHeaders = new Headers({
    "content-type": "application/json",
    origin: "https://shorted.com.au",
  });
  Object.entries(headers).forEach(([key, value]) => {
    requestHeaders.set(key, value);
  });

  return {
    url: `https://shorted.com.au/chat.v1.ChatService/${method}`,
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ message: "hello" }),
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

describe("chat RPC proxy", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      INTERNAL_SERVICE_SECRET: "server-secret",
      CHAT_SERVICE_INTERNAL_URL: "https://chat-service.example",
    };
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
      expires: "2099-01-01T00:00:00.000Z",
    });
    mockGetSubscriptionStatus.mockResolvedValue(subscription());
    mockRateLimit.mockResolvedValue({ success: true });
    fetchMock = jest.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    global.fetch = fetchMock;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as typeof globalThis & { fetch?: typeof fetch }).fetch;
    }
    process.env = originalEnv;
  });

  it("rejects unauthenticated chat RPC calls before proxying", async () => {
    mockAuth.mockResolvedValue(null);

    const response = await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-premium users before proxying", async () => {
    mockGetSubscriptionStatus.mockResolvedValue(
      subscription({
        status: "inactive",
        tier: "free",
        hasActiveSubscription: false,
        isPremium: false,
        canMintTokens: false,
      }),
    );

    const response = await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "canceled premium",
      subscription({
        status: "canceled",
        tier: "premium",
        hasActiveSubscription: false,
        isPremium: true,
      }),
    ],
    [
      "past-due premium",
      subscription({
        status: "past_due",
        tier: "premium",
        hasActiveSubscription: false,
        isPremium: true,
      }),
    ],
    [
      "active free tier",
      subscription({
        status: "active",
        tier: "free",
        hasActiveSubscription: true,
        isPremium: false,
      }),
    ],
    [
      "malformed active flag",
      subscription({
        status: "active",
        tier: "premium",
        hasActiveSubscription: false,
        isPremium: true,
      }),
    ],
    [
      "inactive enterprise",
      subscription({
        status: "inactive",
        tier: "enterprise",
        hasActiveSubscription: false,
        isPremium: true,
      }),
    ],
  ])("rejects invalid chat entitlement for %s before proxying", async (_, info) => {
    mockGetSubscriptionStatus.mockResolvedValue(info);

    const response = await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows trialing paid users through entitlement checks", async () => {
    mockGetSubscriptionStatus.mockResolvedValue(
      subscription({
        status: "trialing",
        tier: "pro",
        hasActiveSubscription: true,
        isPremium: true,
      }),
    );

    const response = await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when subscription entitlement lookup fails", async () => {
    mockGetSubscriptionStatus.mockRejectedValue(new Error("subscription down"));

    const response = await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies isolated per-user minute, daily, and monthly send limits", async () => {
    await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

    expect(mockRateLimit).toHaveBeenCalledTimes(3);
    expect(mockRateLimit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://shorted.com.au/chat.v1.ChatService/SendMessage",
      }),
      expect.objectContaining({
        bucketName: "chat-send-minute",
        authenticatedLimit: 4,
        windowSeconds: 60,
      }),
    );
    expect(mockRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://shorted.com.au/chat.v1.ChatService/SendMessage",
      }),
      expect.objectContaining({
        bucketName: "chat-send-day",
        authenticatedLimit: 40,
        windowSeconds: 86_400,
      }),
    );
    expect(mockRateLimit).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "https://shorted.com.au/chat.v1.ChatService/SendMessage",
      }),
      expect.objectContaining({
        bucketName: "chat-send-month",
        authenticatedLimit: 600,
        windowSeconds: 2_592_000,
      }),
    );
  });

  it("does not proxy when a chat send limit is exceeded", async () => {
    mockRateLimit.mockResolvedValueOnce({
      success: false,
      response: NextResponse.json({ error: "rate limited" }, { status: 429 }),
    });

    const response = await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

    expect(response.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects cross-site chat RPC requests after auth and entitlement checks", async () => {
    const response = await POST(
      requestFor("SendMessage", { origin: "https://evil.example" }),
      {
        params: { method: "SendMessage" },
      },
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses isolated chat quota bucket names including a monthly user bucket", async () => {
    await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

    expect(mockRateLimit).toHaveBeenCalledTimes(3);
    expect(mockRateLimit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://shorted.com.au/chat.v1.ChatService/SendMessage",
      }),
      expect.objectContaining({
        bucketName: "chat-send-minute",
        authenticatedLimit: 4,
        windowSeconds: 60,
      }),
    );
    expect(mockRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://shorted.com.au/chat.v1.ChatService/SendMessage",
      }),
      expect.objectContaining({
        bucketName: "chat-send-day",
        authenticatedLimit: 40,
        windowSeconds: 86_400,
      }),
    );
    expect(mockRateLimit).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "https://shorted.com.au/chat.v1.ChatService/SendMessage",
      }),
      expect.objectContaining({
        bucketName: "chat-send-month",
        authenticatedLimit: 600,
        windowSeconds: 2_592_000,
      }),
    );
  });

  it("injects trusted identity headers and overwrites client-supplied user id", async () => {
    await POST(
      requestFor("SendMessage", {
        authorization: "Bearer browser-token",
        cookie: "session=browser-cookie",
        "x-internal-secret": "attacker-secret",
        "x-user-id": "attacker",
      }),
      {
        params: { method: "SendMessage" },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);

    expect(url).toBe("https://chat-service.example/chat.v1.ChatService/SendMessage");
    expect(headers.get("x-internal-secret")).toBe("server-secret");
    expect(headers.get("x-user-id")).toBe("user-1");
    expect(headers.get("x-user-email")).toBe("user@example.com");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
  });

  it("never forwards a client-supplied x-user-roles header upstream", async () => {
    // The chat service trusts x-user-roles when it arrives with the internal
    // secret. The secret is attached here, so a browser-sent roles header must
    // be dropped, or a caller could grant itself a role.
    await POST(
      requestFor("SendMessage", {
        "x-user-roles": "admin",
        "X-User-Roles": "admin",
      }),
      {
        params: { method: "SendMessage" },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("x-user-roles")).toBeNull();
    expect(headers.get("x-internal-secret")).toBe("server-secret");
  });

  it("fails closed in production when the internal secret is missing", async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;

    const response = await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed in production when the internal chat service URL is missing", async () => {
    delete process.env.CHAT_SERVICE_INTERNAL_URL;
    process.env.NEXT_PUBLIC_CHAT_SERVICE_ENDPOINT = "https://api.shorted.com.au";

    const response = await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("error contract for non-2xx chat service answers", () => {
    it("rebuilds the chat service's plain-text 401 into unavailable, never a session end, without its text", async () => {
      const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        fetchMock.mockResolvedValueOnce(
          new Response("unauthorized", {
            status: 401,
            headers: { "content-type": "text/plain" },
          }),
        );

        const response = await POST(requestFor("GetConversationHistory"), {
          params: { method: "GetConversationHistory" },
        });

        expect(response.status).toBe(503);
        expect(response.headers.get("content-type")).toContain("application/json");
        const body = await response.json();
        expect(body).toMatchObject({
          error: "Chat unavailable",
          code: "unavailable",
          message: expect.any(String),
        });
        expect(JSON.stringify(body)).not.toContain("unauthorized");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("maps a Connect resource_exhausted into rate_limited, with the limit from its header", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: "resource_exhausted", message: "limit" }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "x-chat-limit": JSON.stringify({
                kind: "monthly",
                limit: 600,
                retry_after_seconds: 7200,
                reset_at: 1_800_000_000,
              }),
            },
          },
        ),
      );

      const response = await POST(requestFor("SendMessage"), {
        params: { method: "SendMessage" },
      });

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("7200");
      await expect(response.json()).resolves.toMatchObject({
        code: "rate_limited",
        limitKind: "monthly",
        retryAfterSeconds: 7200,
        resetAt: 1_800_000_000,
      });
    });

    it("maps an upstream 503 to the unavailable contract with a retry hint", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("chat unavailable", { status: 503 }),
      );

      const response = await POST(requestFor("ListConversations"), {
        params: { method: "ListConversations" },
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "unavailable",
        retryAfterSeconds: 60,
      });
    });

    it("answers an unreachable chat service with the unavailable contract instead of a bare 500", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

      const response = await POST(requestFor("ListConversations"), {
        params: { method: "ListConversations" },
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "unavailable",
      });
    });

    it("answers an unknown method with the invalid_request contract", async () => {
      const response = await POST(requestFor("DropTables"), {
        params: { method: "DropTables" },
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_request",
      });
    });

    it("answers a non-premium caller with the premium_required contract", async () => {
      mockGetSubscriptionStatus.mockResolvedValue(
        subscription({
          status: "inactive",
          tier: "free",
          hasActiveSubscription: false,
          isPremium: false,
          canMintTokens: false,
        }),
      );

      const response = await POST(requestFor("SendMessage"), {
        params: { method: "SendMessage" },
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "premium_required",
      });
    });

    it("passes a 2xx stream through untouched", async () => {
      const stream = "data: frame\n\n";
      fetchMock.mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/connect+json" },
        }),
      );

      const response = await POST(requestFor("SendMessage"), {
        params: { method: "SendMessage" },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(stream);
    });
  });

  describe("the answer it passes on", () => {
    // Node's fetch decodes a gzip answer before the proxy reads it, so the body
    // handed on is plain JSON. The headers must describe that body, not the
    // compressed bytes the chat service sent. route-wire.test.ts shows the failure
    // over a socket; these pin the two halves of the fix.
    it("asks the chat service for an uncompressed answer, whatever the browser accepts", async () => {
      await POST(requestFor("ListConversations", { "accept-encoding": "gzip, deflate, br" }), {
        params: { method: "ListConversations" },
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(new Headers(init.headers).get("accept-encoding")).toBe("identity");
    });

    it("drops Content-Encoding from an answer it passes on, so the caller does not decode it twice", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('{"conversations":[]}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        }),
      );

      const response = await POST(requestFor("ListConversations"), {
        params: { method: "ListConversations" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.text()).toBe('{"conversations":[]}');
    });
  });
});
