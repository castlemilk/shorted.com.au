import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import { POST } from "../route";
import { stripe } from "~/lib/stripe";
import { notifyOperator } from "~/@/lib/operator-notify";
import { SubscriptionStatus } from "~/gen/shorts/v1alpha1/billing_pb";

jest.mock("next/headers", () => ({
  headers: () => new Headers({ "stripe-signature": "t=1,v1=test" }),
}));

jest.mock("~/lib/stripe", () => ({
  stripe: {
    webhooks: { constructEvent: jest.fn() },
    subscriptions: { retrieve: jest.fn(), list: jest.fn() },
  },
}));

jest.mock("@connectrpc/connect", () => {
  const goClient = {
    handleStripeCheckoutCompleted: jest.fn(async () => ({})),
    handleStripeSubscriptionUpdated: jest.fn(async () => ({})),
  };
  return { createClient: jest.fn(() => goClient), goClient };
});

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

jest.mock("~/app/actions/config", () => ({
  SHORTS_API_URL: "http://shorts.test",
  serverFetchWithUserAgent: jest.fn(),
}));

jest.mock("~/@/lib/operator-notify", () => ({
  notifyOperator: jest.fn(async () => true),
  formatAmount: (amount: number | null | undefined, currency: string | null | undefined) =>
    amount == null ? "unknown" : `${amount / 100} ${currency ?? ""}`.trim(),
}));

jest.mock("~/@/lib/product-events", () => ({
  recordProductEvent: jest.fn(),
}));

type GoClient = {
  handleStripeCheckoutCompleted: jest.Mock;
  handleStripeSubscriptionUpdated: jest.Mock;
};

const goClient = (jest.requireMock("@connectrpc/connect") as { goClient: GoClient })
  .goClient;
const stripeMock = stripe as unknown as {
  webhooks: { constructEvent: jest.Mock };
  subscriptions: { retrieve: jest.Mock; list: jest.Mock };
};
const notifyMock = notifyOperator as jest.Mock;

const PERIOD_END = Math.floor(Date.UTC(2026, 10, 23) / 1000);

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    ended_at: null,
    canceled_at: null,
    metadata: { userId: "user-1", userEmail: "buyer@example.test" },
    items: {
      data: [
        {
          current_period_start: PERIOD_END - 30 * 24 * 3600,
          current_period_end: PERIOD_END,
          price: { id: "price_premium", unit_amount: 400, currency: "aud" },
        },
      ],
    },
    ...overrides,
  };
}

function deliver(type: string, object: unknown) {
  const event = { id: "evt_1", type, data: { object } } as unknown as Stripe.Event;
  stripeMock.webhooks.constructEvent.mockReturnValueOnce(event);
  return POST({ text: async () => "{}" } as unknown as NextRequest);
}

function updates(): Record<string, unknown>[] {
  return goClient.handleStripeSubscriptionUpdated.mock.calls.map(
    (call) => call[0] as Record<string, unknown>,
  );
}

describe("POST /api/stripe/webhook", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_PREMIUM_PRICE_ID: "price_premium",
      STRIPE_API_ACCESS_PRICE_ID: "price_api_access",
    };
    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each([
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ])("%s re-reads the subscription it names", async (type) => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription());

    const response = await deliver(type, subscription({ id: "sub_event" }));

    expect(response.status).toBe(200);
    expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledWith("sub_event");
  });

  it("syncs the invoice's subscription on payment_succeeded", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription());
    const invoice = {
      id: "in_1",
      customer: "cus_1",
      parent: { subscription_details: { subscription: "sub_1" } },
    };

    const response = await deliver("invoice.payment_succeeded", invoice);

    expect(response.status).toBe(200);
    expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledWith("sub_1");
    expect(updates()[0]).toMatchObject({ status: SubscriptionStatus.ACTIVE });
  });

  it("notifies the operator and syncs the subscription on payment_failed", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(
      subscription({ status: "past_due" }),
    );
    const invoice = {
      id: "in_2",
      customer: "cus_1",
      customer_email: "buyer@example.test",
      amount_due: 400,
      currency: "aud",
      parent: { subscription_details: { subscription: "sub_1" } },
    };

    const response = await deliver("invoice.payment_failed", invoice);

    expect(response.status).toBe(200);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining("payment FAILED") }),
    );
    expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledWith("sub_1");
    // The write is what Stripe reports, not a hard-coded past_due.
    expect(updates()[0]).toMatchObject({ status: SubscriptionStatus.PAST_DUE });
  });

  it("does not change subscription state for a failed payment intent", async () => {
    const intent = {
      id: "pi_1",
      amount: 400,
      currency: "aud",
      customer: "cus_1",
      receipt_email: "buyer@example.test",
      last_payment_error: { message: "declined", decline_code: "insufficient_funds" },
    };

    const response = await deliver("payment_intent.payment_failed", intent);

    expect(response.status).toBe(200);
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(goClient.handleStripeSubscriptionUpdated).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining("attempt FAILED") }),
    );
  });

  it("ignores an invoice that belongs to no subscription", async () => {
    const response = await deliver("invoice.payment_succeeded", {
      id: "in_3",
      customer: null,
      parent: null,
    });

    expect(response.status).toBe(200);
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(goClient.handleStripeSubscriptionUpdated).not.toHaveBeenCalled();
  });

  it("syncs a paid subscription checkout and notifies the operator once", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription());
    const session = {
      id: "cs_1",
      mode: "subscription",
      subscription: "sub_1",
      customer: "cus_1",
      client_reference_id: "user-1",
      customer_email: "buyer@example.test",
      metadata: { userId: "user-1", userEmail: "buyer@example.test" },
      amount_total: 400,
      currency: "aud",
    };

    const response = await deliver("checkout.session.completed", session);

    expect(response.status).toBe(200);
    expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledWith("sub_1");
    expect(goClient.handleStripeCheckoutCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", stripeSubscriptionId: "sub_1" }),
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "New Shorted subscription: buyer@example.test",
        text: expect.stringContaining("Linked:       yes"),
      }),
    );
  });

  it("grants nothing for a paid session with no subscription, and tells the operator", async () => {
    const session = {
      id: "cs_pl",
      mode: "payment",
      subscription: null,
      customer: null,
      metadata: {},
      customer_details: { email: "buyer@example.test" },
      amount_total: 2000,
      currency: "aud",
    };

    const response = await deliver("checkout.session.completed", session);

    expect(response.status).toBe(200);
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(goClient.handleStripeCheckoutCompleted).not.toHaveBeenCalled();
    expect(goClient.handleStripeSubscriptionUpdated).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Shorted payment with nothing to grant",
        text: expect.stringContaining("buyer@example.test"),
      }),
    );
  });

  it("returns 500 when Stripe cannot be read, so the delivery is retried", async () => {
    stripeMock.subscriptions.retrieve.mockRejectedValue(new Error("stripe down"));

    const response = await deliver("customer.subscription.updated", subscription());

    expect(response.status).toBe(500);
  });

  it("returns 400 for a bad signature and does nothing else", async () => {
    stripeMock.webhooks.constructEvent.mockImplementationOnce(() => {
      throw new Error("No signatures found");
    });

    const response = await POST({ text: async () => "{}" } as unknown as NextRequest);

    expect(response.status).toBe(400);
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  describe("delivery order", () => {
    it("keeps a customer canceled when a retried active update arrives after the deletion", async () => {
      // Stripe's current state is canceled. Both deliveries describe the
      // subscription by id, so both re-read it and both write canceled.
      stripeMock.subscriptions.retrieve.mockResolvedValue(
        subscription({ status: "canceled", ended_at: PERIOD_END }),
      );

      await deliver("customer.subscription.deleted", subscription({ status: "canceled" }));
      // Stripe retries the failed updated event; its payload still says active.
      await deliver("customer.subscription.updated", subscription({ status: "active" }));

      const written = updates();
      expect(written).toHaveLength(2);
      for (const write of written) {
        expect(write).toMatchObject({
          status: SubscriptionStatus.CANCELED,
          isDeleted: true,
        });
      }
      expect(written[written.length - 1]).toMatchObject({ isDeleted: true });
      expect(goClient.handleStripeCheckoutCompleted).not.toHaveBeenCalled();
    });

    it("writes the period end whichever of created or checkout arrives first", async () => {
      stripeMock.subscriptions.retrieve.mockResolvedValue(subscription());

      // subscription.created beat checkout.session.completed to the backend in
      // production, which left the row without a period end.
      await deliver("customer.subscription.created", subscription());
      await deliver("checkout.session.completed", {
        id: "cs_1",
        mode: "subscription",
        subscription: "sub_1",
        customer: "cus_1",
        metadata: { userId: "user-1", userEmail: "buyer@example.test" },
        amount_total: 400,
        currency: "aud",
      });

      const written = updates();
      expect(written).toHaveLength(2);
      for (const write of written) {
        expect(Number((write.currentPeriodEnd as { seconds: bigint }).seconds)).toBe(PERIOD_END);
      }
      // Each delivery links the row before writing its status.
      expect(goClient.handleStripeCheckoutCompleted).toHaveBeenCalledTimes(2);
    });
  });
});
