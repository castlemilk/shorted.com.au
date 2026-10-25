import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import { POST } from "../route";
import { stripe } from "~/lib/stripe";
import { notifyOperator, sendResendEmail } from "~/@/lib/operator-notify";
import { SubscriptionStatus } from "~/gen/shorts/v1alpha1/billing_pb";

jest.mock("next/headers", () => ({
  headers: () => new Headers({ "stripe-signature": "t=1,v1=test" }),
}));

jest.mock("~/lib/stripe", () => ({
  stripe: {
    webhooks: { constructEvent: jest.fn() },
    subscriptions: { retrieve: jest.fn(), list: jest.fn() },
    invoices: { list: jest.fn(async () => ({ data: [] })) },
    billingPortal: { sessions: { create: jest.fn() } },
  },
}));

jest.mock("~/@/lib/kv-cache", () => ({
  acquireCacheLease: jest.fn(async () => "acquired"),
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
  sendResendEmail: jest.fn(async () => true),
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
const resendMock = sendResendEmail as jest.Mock;
const portalMock = (stripe as unknown as { billingPortal: { sessions: { create: jest.Mock } } })
  .billingPortal.sessions.create;

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

function lastUpdate(): Record<string, unknown> {
  const calls = goClient.handleStripeSubscriptionUpdated.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
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

  describe("customer-level state", () => {
    it("writes the customer's active subscription when an unpaid sibling's update arrives", async () => {
      const unpaid = subscription({ id: "sub_unpaid", status: "unpaid", created: 200 });
      const active = subscription({ id: "sub_active", status: "active", created: 100 });
      stripeMock.subscriptions.retrieve.mockResolvedValue(unpaid);
      stripeMock.subscriptions.list.mockResolvedValue({
        data: [unpaid, active],
        has_more: false,
      });

      const response = await deliver("customer.subscription.updated", unpaid);

      expect(response.status).toBe(200);
      expect(lastUpdate()).toMatchObject({
        stripeSubscriptionId: "sub_active",
        status: SubscriptionStatus.ACTIVE,
        isDeleted: false,
      });
    });
  });

  describe("payment failure notification", () => {
    const failedInvoice = {
      id: "in_9",
      customer: "cus_1",
      customer_email: "buyer@example.test",
      amount_due: 400,
      currency: "aud",
      parent: { subscription_details: { subscription: "sub_1" } },
    };

    it("notifies only after the sync has succeeded", async () => {
      stripeMock.subscriptions.retrieve.mockResolvedValue(subscription({ status: "past_due" }));

      await deliver("invoice.payment_failed", failedInvoice);

      const syncOrder = goClient.handleStripeSubscriptionUpdated.mock.invocationCallOrder[0] ?? 0;
      const notifyOrder = notifyMock.mock.invocationCallOrder[0] ?? 0;
      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(syncOrder).toBeLessThan(notifyOrder);
    });

    it("does not notify when the sync fails, so Stripe's retry notifies exactly once", async () => {
      stripeMock.subscriptions.retrieve.mockRejectedValueOnce(new Error("stripe timeout"));

      const failedAttempt = await deliver("invoice.payment_failed", failedInvoice);
      expect(failedAttempt.status).toBe(500);
      expect(notifyMock).not.toHaveBeenCalled();

      // The retry succeeds: one notification, sent after the state is written.
      stripeMock.subscriptions.retrieve.mockResolvedValue(subscription({ status: "past_due" }));
      const retry = await deliver("invoice.payment_failed", failedInvoice);
      expect(retry.status).toBe(200);
      expect(notifyMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("delivery order", () => {
    it("keeps a customer canceled when a retried active update arrives after the deletion", async () => {
      // Stripe's current state is canceled. Both deliveries describe the
      // subscription by id, so both re-read it and both write canceled.
      const canceled = subscription({ status: "canceled", ended_at: PERIOD_END });
      stripeMock.subscriptions.retrieve.mockResolvedValue(canceled);
      stripeMock.subscriptions.list.mockResolvedValue({ data: [canceled], has_more: false });

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

describe("POST /api/stripe/webhook: dunning, recovery, refunds and disputes", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_PREMIUM_PRICE_ID: "price_premium",
      NEXTAUTH_URL: "https://shorted.com.au",
    };
    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription({ status: "past_due" }));
    portalMock.mockResolvedValue({ url: "https://billing.stripe.com/p/session/update" });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const failedInvoice = (overrides: Record<string, unknown> = {}) => ({
    id: "in_fail",
    customer: "cus_1",
    customer_email: "buyer@example.test",
    amount_due: 400,
    currency: "aud",
    attempt_count: 1,
    hosted_invoice_url: "https://invoice.stripe.com/i/in_fail",
    parent: { subscription_details: { subscription: "sub_1" } },
    ...overrides,
  });

  /** The customer-facing sends, as opposed to the operator's. */
  const customerSends = () =>
    resendMock.mock.calls.map((call) => call[0] as { to: string; idempotencyKey?: string; text: string });

  it("emails the customer once on the first failed attempt, with a card link and the invoice link", async () => {
    const response = await deliver("invoice.payment_failed", failedInvoice());

    expect(response.status).toBe(200);
    expect(customerSends()).toHaveLength(1);
    expect(customerSends()[0]).toMatchObject({
      to: "buyer@example.test",
      idempotencyKey: "billing-payment-failed-in_fail",
    });
    expect(customerSends()[0].text).toContain("https://billing.stripe.com/p/session/update");
    expect(customerSends()[0].text).toContain("https://invoice.stripe.com/i/in_fail");
    expect(customerSends()[0].text).toContain("Your access continues");
    expect(portalMock).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_1", return_url: "https://shorted.com.au/pricing" }),
    );
  });

  it("gives the same idempotency key on a redelivery, so Resend sends one email", async () => {
    await deliver("invoice.payment_failed", failedInvoice());
    await deliver("invoice.payment_failed", failedInvoice());

    expect(customerSends()).toHaveLength(2);
    expect(customerSends()[0].idempotencyKey).toBe("billing-payment-failed-in_fail");
    expect(customerSends()[1].idempotencyKey).toBe(customerSends()[0].idempotencyKey);
  });

  it("sends no customer email for a retry, since the first attempt already told them", async () => {
    await deliver("invoice.payment_failed", failedInvoice({ attempt_count: 2 }));

    expect(customerSends()).toHaveLength(0);
    // The operator is still told about every failed attempt.
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("sends no customer email when the subscription is not past_due, such as an incomplete first invoice", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription({ status: "incomplete" }));

    await deliver("invoice.payment_failed", failedInvoice());

    expect(customerSends()).toHaveLength(0);
  });

  it("still sends the email with the invoice link when the portal link cannot be made", async () => {
    portalMock.mockRejectedValue(new Error("portal not configured"));

    const response = await deliver("invoice.payment_failed", failedInvoice());

    expect(response.status).toBe(200);
    expect(customerSends()).toHaveLength(1);
    expect(customerSends()[0].text).not.toContain("billing.stripe.com");
    expect(customerSends()[0].text).toContain("https://invoice.stripe.com/i/in_fail");
  });

  it("sends no customer email, and does not fail the webhook, when the invoice has no address", async () => {
    const response = await deliver("invoice.payment_failed", failedInvoice({ customer_email: null }));

    expect(response.status).toBe(200);
    expect(customerSends()).toHaveLength(0);
  });

  it("sends a payment-recovered note when an invoice settles after a failed attempt", async () => {
    const response = await deliver("invoice.paid", {
      id: "in_recovered",
      status: "paid",
      attempt_count: 2,
      customer_email: "buyer@example.test",
    });

    expect(response.status).toBe(200);
    expect(customerSends()).toEqual([
      expect.objectContaining({
        to: "buyer@example.test",
        idempotencyKey: "billing-payment-recovered-in_recovered",
      }),
    ]);
  });

  it("sends no recovery note when the first attempt settles", async () => {
    await deliver("invoice.paid", { id: "in_first", status: "paid", attempt_count: 1, customer_email: "buyer@example.test" });

    expect(customerSends()).toHaveLength(0);
  });

  it("tells the operator about a refund, with counts and ids and no subscription change", async () => {
    stripeMock.subscriptions.retrieve.mockClear();

    const response = await deliver("charge.refunded", {
      id: "ch_refund",
      customer: "cus_1",
      amount: 400,
      amount_refunded: 400,
      currency: "aud",
      billing_details: { email: "buyer@example.test" },
    });

    expect(response.status).toBe(200);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("refund"),
        text: expect.stringContaining("ch_refund"),
      }),
    );
    expect(customerSends()).toHaveLength(0);
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("tells the operator when a dispute is created, with the evidence deadline", async () => {
    const response = await deliver("charge.dispute.created", {
      id: "dp_1",
      amount: 400,
      currency: "aud",
      reason: "fraudulent",
      status: "needs_response",
      charge: "ch_disputed",
      evidence_details: { due_by: PERIOD_END },
    });

    expect(response.status).toBe(200);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("DISPUTED"),
        text: expect.stringMatching(/ch_disputed[\s\S]*dp_1/),
      }),
    );
    expect(customerSends()).toHaveLength(0);
  });
});
