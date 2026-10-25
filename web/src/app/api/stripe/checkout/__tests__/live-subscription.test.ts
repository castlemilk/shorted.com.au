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

  /** The caller's own mirror row names this Stripe customer. */
  function ownCustomer(stripeCustomerId: string) {
    mirrorMock.mockResolvedValue({ ...NO_MIRROR_SUBSCRIPTION, stripeCustomerId });
  }

  it.each(["active", "trialing", "past_due", "unpaid"])(
    "sends a customer whose own subscription is %s to the billing portal, not a second checkout",
    async (status) => {
      ownCustomer("cus_1");
      subscriptionsByCustomer({ cus_1: [{ id: "sub_1", status }] });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        url: "https://billing.stripe.com/p/session/test",
        outcome: "portal_plan_switch",
      });
      expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
      expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_1" }),
      );
    },
  );

  it("opens a subscription-update flow for the own live subscription, returning to /pricing", async () => {
    ownCustomer("cus_1");
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

  it("falls back to a plain card-update portal when Stripe refuses the plan switch", async () => {
    ownCustomer("cus_1");
    subscriptionsByCustomer({ cus_1: [{ id: "sub_1", status: "past_due" }] });
    stripeMock.billingPortal.sessions.create
      .mockRejectedValueOnce(new Error("subscription update not allowed for past_due"))
      .mockResolvedValueOnce({ url: "https://billing.stripe.com/p/session/card" });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await send(request({ tier: "premium" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://billing.stripe.com/p/session/card",
      outcome: "portal_card_update",
    });
    expect(stripeMock.billingPortal.sessions.create).toHaveBeenLastCalledWith({
      customer: "cus_1",
      return_url: "https://shorted.com.au/pricing",
    });
    warn.mockRestore();
  });

  it("gives the 409 with a real next step when no portal session can be created", async () => {
    ownCustomer("cus_1");
    subscriptionsByCustomer({ cus_1: [{ id: "sub_1", status: "active" }] });
    stripeMock.billingPortal.sessions.create.mockRejectedValue(new Error("portal not configured"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await send(request({ tier: "premium" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "already_subscribed",
      message: "You already have a Shorted subscription. Contact support to change it.",
    });
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it("creates a session for a customer whose only subscriptions have ended, using their email and no reused customer", async () => {
    subscriptionsByCustomer({
      cus_1: [
        { id: "sub_gone", status: "canceled" },
        { id: "sub_never", status: "incomplete_expired" },
      ],
    });

    const response = await send(request({ tier: "premium" }));

    expect(response.status).toBe(200);
    // The email-matched customer is not the caller's, so Stripe is not asked to attach
    // the new subscription to it. A new customer is created from the email instead.
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: undefined, customer_email: "customer@example.test" }),
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

  describe("the portal belongs to the caller, never to a customer found by email", () => {
    it("refuses a second checkout, with no portal, when only the email matches a paying customer", async () => {
      // The session email may be unverified. A stranger signing up with a paying
      // customer's email must not reach that customer's billing.
      mirrorMock.mockResolvedValue(NO_MIRROR_SUBSCRIPTION);
      stripeMock.customers.list.mockResolvedValue({ data: [{ id: "cus_victim" }] });
      subscriptionsByCustomer({ cus_victim: [{ id: "sub_victim", status: "active" }] });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "already_subscribed",
        message: "You already have a Shorted subscription. Contact support to change it.",
      });
      expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
      expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it("opens a portal only for the mirror row's customer, never for an email match", async () => {
      ownCustomer("cus_mirror");
      stripeMock.customers.list.mockResolvedValue({ data: [{ id: "cus_email" }] });
      subscriptionsByCustomer({
        cus_email: [{ id: "sub_email", status: "active" }],
        cus_mirror: [{ id: "sub_m", status: "past_due" }],
      });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(200);
      expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledTimes(1);
      expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_mirror" }),
      );
      expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_email" }),
      );
    });

    it("lists a customer shared by the email and the mirror only once", async () => {
      ownCustomer("cus_1");
      subscriptionsByCustomer({ cus_1: [{ id: "sub_gone", status: "canceled" }] });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(200);
      expect(stripeMock.subscriptions.list).toHaveBeenCalledTimes(1);
    });

    it("refuses while the caller's own subscription cannot be read, rather than guessing a customer", async () => {
      mirrorMock.mockResolvedValue({ ...NO_MIRROR_SUBSCRIPTION, lookupFailed: true });
      stripeMock.customers.list.mockResolvedValue({ data: [{ id: "cus_email" }] });
      subscriptionsByCustomer({ cus_email: [{ id: "sub_live", status: "active" }] });
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(503);
      expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
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
