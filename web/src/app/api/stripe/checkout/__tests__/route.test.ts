import { NextRequest } from "next/server";
import { POST } from "../route";
import { stripe } from "~/lib/stripe";
import { auth } from "~/server/auth";
import { rateLimit } from "~/@/lib/rate-limit";
import { recordProductEvent } from "~/@/lib/product-events";

jest.mock("~/lib/stripe", () => ({
  stripe: {
    prices: {
      retrieve: jest.fn(),
    },
    customers: {
      list: jest.fn(),
    },
    checkout: {
      sessions: {
        create: jest.fn(),
      },
    },
  },
}));

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("~/@/lib/rate-limit", () => ({
  rateLimit: jest.fn(),
}));

jest.mock("~/@/lib/product-events", () => ({
  recordProductEvent: jest.fn(),
}));

const stripeMock = stripe as unknown as {
  prices: { retrieve: jest.Mock };
  customers: { list: jest.Mock };
  checkout: { sessions: { create: jest.Mock } };
};

const authMock = auth as jest.Mock;
const rateLimitMock = rateLimit as jest.Mock;
const recordProductEventMock = recordProductEvent as jest.Mock;

const originalEnv = process.env;

describe("/api/stripe/checkout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXTAUTH_URL: "https://shorted.com.au",
      STRIPE_PREMIUM_PRICE_ID: "price_premium",
      STRIPE_PRO_PRICE_ID: "price_legacy_pro",
      STRIPE_API_ACCESS_PRICE_ID: "price_api_access",
    };

    authMock.mockResolvedValue({
      user: {
        id: "user-123",
        email: "customer@example.com",
      },
    });
    rateLimitMock.mockResolvedValue({ success: true });
    stripeMock.prices.retrieve.mockImplementation(async (priceId: string) => {
      if (priceId === "price_premium") {
        return {
          id: priceId,
          active: true,
          unit_amount: 400,
          currency: "aud",
          recurring: { interval: "month" },
        };
      }

      return {
        id: priceId,
        active: true,
        unit_amount: 2000,
        currency: "aud",
        recurring: { interval: "month" },
      };
    });
    stripeMock.customers.list.mockResolvedValue({ data: [] });
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/c/session",
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("creates Premium checkout with the Premium price only", async () => {
    const response = await POST(
      request({ tier: "premium" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://checkout.stripe.com/c/session",
    });
    expect(stripeMock.prices.retrieve).toHaveBeenCalledWith("price_premium");
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_premium", quantity: 1 }],
        metadata: expect.objectContaining({ tier: "premium" }),
        subscription_data: expect.objectContaining({
          metadata: expect.objectContaining({ tier: "premium" }),
        }),
      })
    );
  });

  it("creates API Access checkout with the API Access price only", async () => {
    const response = await POST(
      request({ tier: "api_access" })
    );

    expect(response.status).toBe(200);
    expect(stripeMock.prices.retrieve).toHaveBeenCalledWith("price_api_access");
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_api_access", quantity: 1 }],
        metadata: expect.objectContaining({ tier: "api_access" }),
      })
    );
  });

  it("fails closed when the Premium env var points at the API Access amount", async () => {
    stripeMock.prices.retrieve.mockResolvedValueOnce({
      id: "price_premium",
      active: true,
      unit_amount: 2000,
      currency: "aud",
      recurring: { interval: "month" },
    });

    const response = await POST(
      request({ tier: "premium" })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error:
        "Payment pricing is misconfigured. Please contact support before subscribing.",
    });
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(recordProductEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        properties: expect.objectContaining({
          tier: "premium",
          error_type: "price_mismatch",
        }),
      })
    );
  });

  it("does not fall back API Access to Premium when the API price is missing", async () => {
    delete process.env.STRIPE_API_ACCESS_PRICE_ID;

    const response = await POST(
      request({ tier: "api_access" })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "API Access pricing is not configured",
    });
    expect(stripeMock.prices.retrieve).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3020/api/stripe/checkout", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
