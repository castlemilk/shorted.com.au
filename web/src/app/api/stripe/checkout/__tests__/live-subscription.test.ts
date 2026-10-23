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
    mirrorMock.mockResolvedValue(NO_MIRROR_SUBSCRIPTION);
    subscriptionsByCustomer({});
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each(["active", "trialing", "past_due", "unpaid"])(
    "refuses a second checkout when the customer's subscription is %s",
    async (status) => {
      subscriptionsByCustomer({ cus_1: [{ id: "sub_1", status }] });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "already_subscribed",
        message:
          "You already have a Shorted subscription. Manage it from your account settings.",
      });
      expect(stripeMock.subscriptions.list).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_1", status: "all" }),
      );
      expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    },
  );

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
    it("refuses a second checkout when the mirror's customer has a live subscription, even though the email matched no customer", async () => {
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

      expect(response.status).toBe(409);
      expect(stripeMock.subscriptions.list).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_mirror" }),
      );
      expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it("checks both customers when the email and the mirror name different ones, and refuses on either", async () => {
      mirrorMock.mockResolvedValue({
        ...NO_MIRROR_SUBSCRIPTION,
        stripeCustomerId: "cus_mirror",
      });
      subscriptionsByCustomer({
        cus_1: [{ id: "sub_email", status: "canceled" }],
        cus_mirror: [{ id: "sub_m", status: "past_due" }],
      });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(409);
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

    it("fails closed with 503 when the mirror cannot be read, and creates no session", async () => {
      mirrorMock.mockResolvedValue({ ...NO_MIRROR_SUBSCRIPTION, lookupFailed: true });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
      await expect(response.json()).resolves.toMatchObject({
        error: "Subscription check unavailable",
      });
      expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
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
