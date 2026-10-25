import { NextRequest } from "next/server";
import { GET } from "../route";
import { auth } from "~/server/auth";
import { stripe } from "~/lib/stripe";
import { getSubscriptionStatus } from "~/app/actions/subscription";
import { rateLimit } from "~/@/lib/rate-limit";

jest.mock("~/server/auth", () => ({ auth: jest.fn() }));

jest.mock("~/lib/stripe", () => ({
  stripe: { billingPortal: { sessions: { create: jest.fn() } } },
}));

jest.mock("~/app/actions/subscription", () => ({
  getSubscriptionStatus: jest.fn(),
}));

jest.mock("~/@/lib/rate-limit", () => ({ rateLimit: jest.fn() }));

const authMock = auth as jest.Mock;
const portalMock = (stripe as unknown as { billingPortal: { sessions: { create: jest.Mock } } })
  .billingPortal.sessions.create;
const mirrorMock = getSubscriptionStatus as jest.Mock;

const NO_MIRROR = {
  status: "inactive",
  tier: "free",
  hasActiveSubscription: false,
  isPremium: false,
  lookupFailed: false,
};

function request() {
  return new NextRequest("https://shorted.com.au/billing/portal");
}

describe("GET /billing/portal", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, NEXTAUTH_URL: "https://shorted.com.au" };
    (rateLimit as jest.Mock).mockResolvedValue({ success: true });
    portalMock.mockResolvedValue({ url: "https://billing.stripe.com/p/session/fresh" });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("redirects a signed-in customer to a fresh portal session for their own customer", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", email: "buyer@example.test" } });
    mirrorMock.mockResolvedValue({ ...NO_MIRROR, stripeCustomerId: "cus_own" });

    const response = await GET(request());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://billing.stripe.com/p/session/fresh");
    expect(portalMock).toHaveBeenCalledWith({
      customer: "cus_own",
      return_url: "https://shorted.com.au/pricing",
    });
  });

  it("sends a signed-out visitor to sign in, and opens no portal", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/signin");
    expect(location.searchParams.get("callbackUrl")).toBe("/billing/portal");
    expect(portalMock).not.toHaveBeenCalled();
  });

  it("sends a signed-in customer with no Stripe customer to pricing, opening no portal", async () => {
    authMock.mockResolvedValue({ user: { id: "user-2", email: "free@example.test" } });
    mirrorMock.mockResolvedValue(NO_MIRROR);

    const response = await GET(request());

    expect(response.headers.get("location")).toBe("https://shorted.com.au/pricing?billing=unavailable");
    expect(portalMock).not.toHaveBeenCalled();
  });

  it("opens no portal while the caller's own subscription cannot be read", async () => {
    authMock.mockResolvedValue({ user: { id: "user-3", email: "buyer@example.test" } });
    mirrorMock.mockResolvedValue({ ...NO_MIRROR, lookupFailed: true, stripeCustomerId: "cus_stale" });

    const response = await GET(request());

    expect(response.headers.get("location")).toBe("https://shorted.com.au/pricing?billing=unavailable");
    expect(portalMock).not.toHaveBeenCalled();
  });
});
