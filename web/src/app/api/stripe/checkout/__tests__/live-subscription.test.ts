import { NextRequest, type NextResponse } from "next/server";
import { POST } from "../route";
import { stripe } from "~/lib/stripe";
import { auth } from "~/server/auth";
import { rateLimit } from "@/lib/rate-limit";
import { getSubscriptionStatus } from "~/app/actions/subscription";

jest.mock("~/lib/stripe", () => ({
  stripe: {
    prices: { retrieve: jest.fn() },
    customers: { list: jest.fn() },
    subscriptions: { list: jest.fn(), retrieve: jest.fn() },
    checkout: { sessions: { create: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
  },
}));

jest.mock("~/server/auth", () => ({ auth: jest.fn() }));

jest.mock("~/@/lib/rate-limit", () => ({ rateLimit: jest.fn() }));

jest.mock("~/@/lib/product-events", () => ({ recordProductEvent: jest.fn() }));

jest.mock("~/app/actions/subscription", () => ({
  getSubscriptionStatus: jest.fn(),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({})),
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

jest.mock("~/app/actions/config", () => ({
  SHORTS_API_URL: "http://shorts.test",
  serverFetchWithUserAgent: jest.fn(),
}));

const stripeMock = stripe as unknown as {
  prices: { retrieve: jest.Mock };
  customers: { list: jest.Mock };
  subscriptions: { list: jest.Mock };
  checkout: { sessions: { create: jest.Mock } };
  billingPortal: { sessions: { create: jest.Mock } };
};
const mirrorMock = getSubscriptionStatus as jest.Mock;

/** The mirror's answer for this user: no subscription unless a test says otherwise. */
const NO_MIRROR_SUBSCRIPTION = {
  status: "inactive",
  tier: "free",
  hasActiveSubscription: false,
  isPremium: false,
};

/** Stripe subscriptions by customer id, as the per-customer list returns them. */
function subscriptionsByCustomer(byCustomer: Record<string, Array<{ id: string; status: string }>>) {
  stripeMock.subscriptions.list.mockImplementation(async (params: { customer: string }) => ({
    data: byCustomer[params.customer] ?? [],
    has_more: false,
  }));
}

describe("POST /api/stripe/checkout with an existing subscription", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXTAUTH_URL: "https://shorted.com.au",
      STRIPE_PREMIUM_PRICE_ID: "price_premium",
    };
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user-123", email: "customer@example.test" },
    });
    (rateLimit as jest.Mock).mockResolvedValue({ success: true });
    stripeMock.prices.retrieve.mockResolvedValue({
      id: "price_premium",
      active: true,
      unit_amount: 400,
      currency: "aud",
      recurring: { interval: "month" },
    });
    stripeMock.customers.list.mockResolvedValue({ data: [{ id: "cus_1" }] });
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/c/session",
    });
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.com/p/session/test",
    });
    mirrorMock.mockResolvedValue(NO_MIRROR_SUBSCRIPTION);
    subscriptionsByCustomer({});
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each(["active", "trialing", "past_due", "unpaid"])(
    "sends a customer whose subscription is %s to the billing portal, not a second checkout",
    async (status) => {
      subscriptionsByCustomer({ cus_1: [{ id: "sub_1", status }] });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        url: "https://billing.stripe.com/p/session/test",
        outcome: "portal_plan_switch",
      });
      expect(stripeMock.subscriptions.list).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_1", status: "all" }),
      );
      expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    },
  );

  it("opens a subscription-update flow for the live subscription, returning to /pricing", async () => {
    subscriptionsByCustomer({
      cus_1: [
        { id: "sub_old", status: "canceled" },
        { id: "sub_live", status: "active" },
      ],
    });

    await send(request({ tier: "premium" }));

    expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: "cus_1",
      return_url: "https://shorted.com.au/pricing",
      flow_data: {
        type: "subscription_update",
        subscription_update: { subscription: "sub_live" },
      },
    });
  });

  it("gives the 409 with a real next step when the portal session cannot be created", async () => {
    subscriptionsByCustomer({ cus_1: [{ id: "sub_1", status: "active" }] });
    stripeMock.billingPortal.sessions.create.mockRejectedValue(new Error("portal not configured"));

    const response = await send(request({ tier: "premium" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "already_subscribed",
      message: "You already have a Shorted subscription. Contact support to change it.",
    });
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("creates a session when the customer's only subscriptions have ended", async () => {
    subscriptionsByCustomer({
      cus_1: [
        { id: "sub_gone", status: "canceled" },
        { id: "sub_never", status: "incomplete_expired" },
      ],
    });

    const response = await send(request({ tier: "premium" }));

    expect(response.status).toBe(200);
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_1" }),
    );
  });

  it("creates a session without looking up subscriptions for a new customer", async () => {
    stripeMock.customers.list.mockResolvedValue({ data: [] });

    const response = await send(request({ tier: "premium" }));

    expect(response.status).toBe(200);
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: undefined,
        customer_email: "customer@example.test",
      }),
    );
  });

  describe("the user's own mirror row", () => {
    it("sends a customer whose mirror row says they pay to the billing portal", async () => {
      // The Stripe customer that pays is not the one this email finds, so only the
      // mirror can say the user already pays.
      stripeMock.customers.list.mockResolvedValue({ data: [] });
      mirrorMock.mockResolvedValue({
        ...NO_MIRROR_SUBSCRIPTION,
        status: "active",
        hasActiveSubscription: true,
        isPremium: true,
        stripeCustomerId: "cus_mirror",
      });
      subscriptionsByCustomer({ cus_mirror: [{ id: "sub_m", status: "active" }] });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(200);
      expect(stripeMock.subscriptions.list).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_mirror" }),
      );
      expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it("checks both customers when the email and the mirror name different ones, and sends either to the portal", async () => {
      mirrorMock.mockResolvedValue({
        ...NO_MIRROR_SUBSCRIPTION,
        stripeCustomerId: "cus_mirror",
      });
      subscriptionsByCustomer({
        cus_1: [{ id: "sub_email", status: "canceled" }],
        cus_mirror: [{ id: "sub_m", status: "past_due" }],
      });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(200);
      const checked = stripeMock.subscriptions.list.mock.calls.map(
        (call) => (call[0] as { customer: string }).customer,
      );
      expect(checked.sort()).toEqual(["cus_1", "cus_mirror"]);
    });

    it("lists a customer shared by the email and the mirror only once", async () => {
      mirrorMock.mockResolvedValue({
        ...NO_MIRROR_SUBSCRIPTION,
        stripeCustomerId: "cus_1",
      });
      subscriptionsByCustomer({ cus_1: [{ id: "sub_gone", status: "canceled" }] });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(200);
      expect(stripeMock.subscriptions.list).toHaveBeenCalledTimes(1);
    });

    it("falls back to the Stripe customer check when the mirror cannot be read", async () => {
      mirrorMock.mockResolvedValue({ ...NO_MIRROR_SUBSCRIPTION, lookupFailed: true });
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(200);
      expect(stripeMock.checkout.sessions.create).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("still refuses when the mirror cannot be read but the email's customer pays", async () => {
      mirrorMock.mockResolvedValue({ ...NO_MIRROR_SUBSCRIPTION, lookupFailed: true });
      stripeMock.customers.list.mockResolvedValue({ data: [{ id: "cus_email" }] });
      stripeMock.subscriptions.list.mockResolvedValue({ data: [{ id: "sub_live", status: "active" }] });
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(200);
      expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe("session lifetime", () => {
    it("expires the session 31 minutes out, inside Stripe's 30 minute to 24 hour window", async () => {
      const before = Math.floor(Date.now() / 1000);

      await send(request({ tier: "premium" }));

      const after = Math.floor(Date.now() / 1000);
      const { expires_at: expiresAt } = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as {
        expires_at: number;
      };
      // Stripe refuses anything under 30 minutes from the moment it receives the
      // request. 31 minutes leaves room for the request to travel.
      expect(expiresAt).toBeGreaterThanOrEqual(before + 31 * 60);
      expect(expiresAt).toBeLessThanOrEqual(after + 31 * 60);
      expect(expiresAt - before).toBeGreaterThanOrEqual(30 * 60);
      expect(expiresAt - before).toBeLessThanOrEqual(24 * 60 * 60);
    });
  });
});

// The route's rate-limit branch can return no response, so the type admits
// undefined. A real request always gets one.
async function send(request: NextRequest): Promise<NextResponse> {
  return (await POST(request)) as NextResponse;
}

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3020/api/stripe/checkout", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
