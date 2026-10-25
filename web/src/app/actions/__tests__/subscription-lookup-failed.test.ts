import { getSubscriptionStatus, createCheckoutSession } from "../subscription";
import { auth } from "~/server/auth";
import { SubscriptionStatus, SubscriptionTier } from "~/gen/shorts/v1alpha1/billing_pb";

jest.mock("~/server/auth", () => ({ auth: jest.fn() }));

jest.mock("~/lib/stripe", () => ({
  SUBSCRIPTION_TIERS: {
    free: { features: ["free"], requestsPerDay: 100 },
    premium: { features: ["premium"], requestsPerDay: 10000 },
    pro: { features: ["premium"], requestsPerDay: 10000 },
    enterprise: { features: ["enterprise"], requestsPerDay: -1 },
  },
  isPremiumTier: (tier: string) => tier === "premium" || tier === "pro" || tier === "enterprise",
  canMintApiTokensForTier: (tier: string) =>
    tier === "premium" || tier === "pro" || tier === "enterprise" || tier === "api_access",
}));

// Backoff delays are not what these tests are about.
jest.mock("@/lib/retry", () => ({
  retryWithBackoff: (fn: () => Promise<unknown>) => fn(),
}));

const mockGetMySubscription = jest.fn();

jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getMySubscription: (...args: unknown[]) => mockGetMySubscription(...args),
  })),
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

jest.mock("~/app/actions/config", () => ({
  SHORTS_API_URL: "http://shorts.test",
  serverFetchWithUserAgent: jest.fn(),
}));

const authMock = auth as jest.Mock;

describe("getSubscriptionStatus lookup failures", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1", email: "buyer@example.test" } });
  });

  it("marks a backend or transport failure as a failed lookup, not as free", async () => {
    mockGetMySubscription.mockRejectedValue(new Error("connection reset"));

    const info = await getSubscriptionStatus();

    expect(info.lookupFailed).toBe(true);
    expect(info.isPremium).toBe(false);
    expect(info.hasActiveSubscription).toBe(false);
  });

  it("does not mark a successful active answer as failed", async () => {
    mockGetMySubscription.mockResolvedValue({
      hasSubscription: true,
      status: SubscriptionStatus.ACTIVE,
      tier: SubscriptionTier.PREMIUM,
      cancelAtPeriodEnd: false,
      stripeCustomerId: "cus_1",
    });

    const info = await getSubscriptionStatus();

    expect(info.lookupFailed).toBeFalsy();
    expect(info.isPremium).toBe(true);
  });

  it("does not mark a genuine no-subscription answer as failed", async () => {
    mockGetMySubscription.mockResolvedValue({ hasSubscription: false });

    const info = await getSubscriptionStatus();

    expect(info.lookupFailed).toBeFalsy();
    expect(info.status).toBe("inactive");
    expect(info.isPremium).toBe(false);
  });

  it("does not mark a signed-out visitor as failed", async () => {
    authMock.mockResolvedValue(null);

    const info = await getSubscriptionStatus();

    expect(info.lookupFailed).toBeFalsy();
    expect(mockGetMySubscription).not.toHaveBeenCalled();
  });
});

describe("createCheckoutSession error text", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1", email: "buyer@example.test" } });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("shows the readable message, not the machine code, for an already-subscribed 409", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: "already_subscribed",
        message: "You already have a Shorted subscription. Manage it from your account settings.",
      }),
    }) as unknown as typeof fetch;

    await expect(createCheckoutSession()).resolves.toEqual({
      url: null,
      error: "You already have a Shorted subscription. Manage it from your account settings.",
    });
  });

  it("keeps the plain error for other failures", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Payment pricing is misconfigured." }),
    }) as unknown as typeof fetch;

    await expect(createCheckoutSession()).resolves.toEqual({
      url: null,
      error: "Payment pricing is misconfigured.",
    });
  });
});
