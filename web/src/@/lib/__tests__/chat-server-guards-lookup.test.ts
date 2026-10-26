import { NextRequest } from "next/server";
import { authorizeChatRequest } from "../chat-server-guards";
import { auth } from "~/server/auth";
import { getSubscriptionStatus } from "~/app/actions/subscription";

jest.mock("~/server/auth", () => ({ auth: jest.fn() }));

jest.mock("~/app/actions/subscription", () => ({
  getSubscriptionStatus: jest.fn(),
}));

jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn(async () => ({ success: true })),
}));

jest.mock("@/lib/product-events", () => ({
  recordProductEvent: jest.fn(),
}));

const authMock = auth as jest.Mock;
const subscriptionMock = getSubscriptionStatus as jest.Mock;

function chatRequest(): NextRequest {
  return new NextRequest("http://localhost:3020/api/chat", { method: "POST" });
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    status: "inactive",
    tier: "free",
    hasActiveSubscription: false,
    isPremium: false,
    canMintTokens: false,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    features: [],
    requestsPerDay: 100,
    ...overrides,
  };
}

describe("authorizeChatRequest subscription lookup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1", email: "buyer@example.test" } });
  });

  it("answers 503 unavailable, not 403, when the subscription lookup failed", async () => {
    subscriptionMock.mockResolvedValue(subscription({ lookupFailed: true }));

    const result = await authorizeChatRequest(chatRequest(), "SendMessage");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("Retry-After")).toBe("30");
    await expect(result.response.json()).resolves.toEqual({
      error: "Chat unavailable",
      code: "unavailable",
      message: "Chat is temporarily unavailable. Please try again shortly.",
      retryAfterSeconds: 30,
    });
  });

  it("keeps refusing a lookup that throws with 403, as before", async () => {
    subscriptionMock.mockRejectedValue(new Error("boom"));

    const result = await authorizeChatRequest(chatRequest(), "SendMessage");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
  });

  it("still answers 403 for a confirmed non-subscriber", async () => {
    subscriptionMock.mockResolvedValue(subscription());

    const result = await authorizeChatRequest(chatRequest(), "SendMessage");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({
      error: "Premium subscription required",
      code: "premium_required",
      message: "Shorted AI is included with a paid subscription.",
    });
  });
});
