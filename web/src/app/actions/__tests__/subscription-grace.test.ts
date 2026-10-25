import { getSubscriptionStatus } from "../subscription";
import { auth } from "~/server/auth";
import { SubscriptionStatus, SubscriptionTier } from "~/gen/shorts/v1alpha1/billing_pb";

jest.mock("~/server/auth", () => ({ auth: jest.fn() }));

// Only the tier table and the premium check are read from the stripe module here.
jest.mock("~/lib/stripe", () => ({
  SUBSCRIPTION_TIERS: {
    free: { features: ["free"], requestsPerDay: 100 },
    premium: { features: ["premium"], requestsPerDay: 10000 },
    api_access: { features: ["api"], requestsPerDay: 10000 },
    enterprise: { features: ["enterprise"], requestsPerDay: -1 },
  },
  isPremiumTier: (tier: string) => tier === "premium" || tier === "pro" || tier === "enterprise",
  canMintApiTokensForTier: (tier: string) =>
    tier === "premium" || tier === "pro" || tier === "enterprise" || tier === "api_access",
}));

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

const DAY = 24 * 60 * 60;
const secondsAgo = (days: number) => ({ seconds: BigInt(Math.floor(Date.now() / 1000) - days * DAY), nanos: 0 });
const secondsAhead = (days: number) => ({ seconds: BigInt(Math.floor(Date.now() / 1000) + days * DAY), nanos: 0 });

describe("getSubscriptionStatus: the grace after a failed charge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as jest.Mock).mockResolvedValue({ user: { id: "user-1", email: "buyer@example.test" } });
  });

  it("keeps a premium customer entitled inside the grace from the failed charge", async () => {
    mockGetMySubscription.mockResolvedValue({
      hasSubscription: true,
      status: SubscriptionStatus.PAST_DUE,
      tier: SubscriptionTier.PREMIUM,
      pastDueSince: secondsAgo(2),
    });

    const info = await getSubscriptionStatus();

    expect(info.status).toBe("past_due");
    expect(info.hasActiveSubscription).toBe(true);
    expect(info.isPremium).toBe(true);
  });

  it("ends the entitlement 14 days after the failed charge, even while the period end is in the future", async () => {
    mockGetMySubscription.mockResolvedValue({
      hasSubscription: true,
      status: SubscriptionStatus.PAST_DUE,
      tier: SubscriptionTier.PREMIUM,
      pastDueSince: secondsAgo(15),
      currentPeriodEnd: secondsAhead(20),
    });

    const info = await getSubscriptionStatus();

    expect(info.hasActiveSubscription).toBe(false);
    expect(info.isPremium).toBe(false);
  });

  it("does not anchor the grace on the period end: a future period end with no failure time grants nothing", async () => {
    mockGetMySubscription.mockResolvedValue({
      hasSubscription: true,
      status: SubscriptionStatus.PAST_DUE,
      tier: SubscriptionTier.PREMIUM,
      currentPeriodEnd: secondsAhead(20),
    });

    const info = await getSubscriptionStatus();

    expect(info.hasActiveSubscription).toBe(false);
  });

  it("keeps an API Access customer's tokens inside the grace, without making them premium", async () => {
    mockGetMySubscription.mockResolvedValue({
      hasSubscription: true,
      status: SubscriptionStatus.PAST_DUE,
      tier: SubscriptionTier.API_ACCESS,
      pastDueSince: secondsAgo(2),
    });

    const info = await getSubscriptionStatus();

    expect(info.hasActiveSubscription).toBe(true);
    expect(info.isPremium).toBe(false);
    expect(info.canMintTokens).toBe(true);
  });

  it("never grants an unpaid subscription, whatever its failure time", async () => {
    mockGetMySubscription.mockResolvedValue({
      hasSubscription: true,
      status: SubscriptionStatus.INACTIVE,
      tier: SubscriptionTier.PREMIUM,
      pastDueSince: secondsAgo(1),
    });

    const info = await getSubscriptionStatus();

    expect(info.hasActiveSubscription).toBe(false);
  });
});
