import { NextRequest, type NextResponse } from "next/server";
import { POST } from "../route";
import { stripe } from "~/lib/stripe";
import { auth } from "~/server/auth";
import { rateLimit } from "@/lib/rate-limit";

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
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each(["active", "trialing", "past_due", "unpaid"])(
    "refuses a second checkout when the customer's subscription is %s",
    async (status) => {
      stripeMock.subscriptions.list.mockResolvedValue({ data: [{ id: "sub_1", status }] });

      const response = await send(request({ tier: "premium" }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "already_subscribed",
        message:
          "You already have a Shorted subscription. Manage it from your account settings.",
      });
      expect(stripeMock.subscriptions.list).toHaveBeenCalledWith({
        customer: "cus_1",
        status: "all",
        limit: 10,
      });
      expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    },
  );

  it("creates a session when the customer's only subscriptions have ended", async () => {
    stripeMock.subscriptions.list.mockResolvedValue({
      data: [
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
