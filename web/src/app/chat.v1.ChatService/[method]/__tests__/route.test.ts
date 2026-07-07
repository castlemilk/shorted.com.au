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
  return new NextRequest(
    `https://shorted.com.au/chat.v1.ChatService/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ message: "hello" }),
    },
  );
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

  it("applies per-user minute and daily send limits", async () => {
    await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

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

  it("injects trusted identity headers and overwrites client-supplied user id", async () => {
    await POST(requestFor("SendMessage", { "x-user-id": "attacker" }), {
      params: { method: "SendMessage" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);

    expect(url).toBe("https://chat-service.example/chat.v1.ChatService/SendMessage");
    expect(headers.get("x-internal-secret")).toBe("server-secret");
    expect(headers.get("x-user-id")).toBe("user-1");
    expect(headers.get("x-user-email")).toBe("user@example.com");
  });

  it("fails closed in production when the internal secret is missing", async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;

    const response = await POST(requestFor("SendMessage"), {
      params: { method: "SendMessage" },
    });

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
