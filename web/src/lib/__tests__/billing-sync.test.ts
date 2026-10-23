import type Stripe from "stripe";
import { stripe } from "~/lib/stripe";
import {
  SubscriptionStatus,
  SubscriptionTier,
} from "~/gen/shorts/v1alpha1/billing_pb";
import {
  idOf,
  isLiveStripeStatus,
  planForPrice,
  resolveSubscriptionIdForInvoice,
  syncSubscriptionFromStripe,
} from "~/lib/billing-sync";

jest.mock("~/lib/stripe", () => ({
  stripe: {
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

type GoClient = {
  handleStripeCheckoutCompleted: jest.Mock;
  handleStripeSubscriptionUpdated: jest.Mock;
};

const goClient = (jest.requireMock("@connectrpc/connect") as { goClient: GoClient })
  .goClient;
const stripeMock = stripe as unknown as {
  subscriptions: { retrieve: jest.Mock; list: jest.Mock };
};

const PROTO = {
  ACTIVE: SubscriptionStatus.ACTIVE,
  TRIALING: SubscriptionStatus.TRIALING,
  PAST_DUE: SubscriptionStatus.PAST_DUE,
  CANCELED: SubscriptionStatus.CANCELED,
  INACTIVE: SubscriptionStatus.INACTIVE,
};
const PREMIUM_TIER = SubscriptionTier.PREMIUM;

const PERIOD_START = Math.floor(Date.UTC(2026, 9, 23) / 1000);
const PERIOD_END = Math.floor(Date.UTC(2026, 10, 23) / 1000);

function subscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
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
          current_period_start: PERIOD_START,
          current_period_end: PERIOD_END,
          price: {
            id: "price_premium",
            unit_amount: 400,
            currency: "aud",
            recurring: { interval: "month" },
          },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function lastUpdate(): Record<string, unknown> {
  const calls = goClient.handleStripeSubscriptionUpdated.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
}

describe("syncSubscriptionFromStripe", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      STRIPE_PREMIUM_PRICE_ID: "price_premium",
      STRIPE_PRO_PRICE_ID: "",
      STRIPE_API_ACCESS_PRICE_ID: "price_api_access",
    };
    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("ensures the row for a live subscription, then writes the full state", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription());

    const result = await syncSubscriptionFromStripe("sub_1");

    expect(goClient.handleStripeCheckoutCompleted).toHaveBeenCalledWith({
      userId: "user-1",
      userEmail: "buyer@example.test",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      tier: PREMIUM_TIER,
    });

    const update = lastUpdate();
    expect(update).toMatchObject({
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      status: PROTO.ACTIVE,
      isDeleted: false,
      cancelAtPeriodEnd: false,
    });
    expect(Number((update.currentPeriodEnd as { seconds: bigint }).seconds)).toBe(PERIOD_END);
    expect(Number((update.currentPeriodStart as { seconds: bigint }).seconds)).toBe(PERIOD_START);

    // The row is created before the status write, so the status write is the
    // one that stands.
    const checkoutOrder = goClient.handleStripeCheckoutCompleted.mock.invocationCallOrder[0] ?? 0;
    const updateOrder = goClient.handleStripeSubscriptionUpdated.mock.invocationCallOrder[0] ?? 0;
    expect(checkoutOrder).toBeLessThan(updateOrder);

    expect(result).toEqual({
      subscriptionId: "sub_1",
      status: "active",
      tier: "premium",
      currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString(),
      cancelAtPeriodEnd: false,
      ensuredRow: true,
    });
  });

  it.each([
    ["trialing", PROTO.TRIALING, "trialing"],
    ["past_due", PROTO.PAST_DUE, "past_due"],
    ["unpaid", PROTO.PAST_DUE, "past_due"],
  ])("maps %s to a live status and ensures the row", async (stripeStatus, proto, name) => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription({ status: stripeStatus }));

    const result = await syncSubscriptionFromStripe("sub_1");

    expect(goClient.handleStripeCheckoutCompleted).toHaveBeenCalledTimes(1);
    expect(lastUpdate()).toMatchObject({ status: proto, isDeleted: false });
    expect(result.status).toBe(name);
    expect(result.ensuredRow).toBe(true);
  });

  it.each(["incomplete", "incomplete_expired", "paused"])(
    "writes %s as inactive without creating a row",
    async (stripeStatus) => {
      stripeMock.subscriptions.retrieve.mockResolvedValue(subscription({ status: stripeStatus }));

      const result = await syncSubscriptionFromStripe("sub_1");

      expect(goClient.handleStripeCheckoutCompleted).not.toHaveBeenCalled();
      expect(lastUpdate()).toMatchObject({ status: PROTO.INACTIVE, isDeleted: false });
      expect(result).toMatchObject({ status: "inactive", ensuredRow: false });
    },
  );

  it("writes a canceled subscription as deleted and never ensures a row for it", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription({ status: "canceled" }));

    const result = await syncSubscriptionFromStripe("sub_1");

    expect(goClient.handleStripeCheckoutCompleted).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: PROTO.CANCELED, isDeleted: true });
    expect(result).toMatchObject({ status: "canceled", tier: "free", ensuredRow: false });
  });

  it("does not ensure a row when the subscription carries no user identity", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription({ metadata: {} }));

    const result = await syncSubscriptionFromStripe("sub_1");

    expect(goClient.handleStripeCheckoutCompleted).not.toHaveBeenCalled();
    expect(goClient.handleStripeSubscriptionUpdated).toHaveBeenCalledTimes(1);
    expect(result.ensuredRow).toBe(false);
  });

  it("uses the hint when the subscription metadata lacks the identity", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription({ metadata: {} }));

    await syncSubscriptionFromStripe("sub_1", {
      userId: "hint-user",
      userEmail: "hint@example.test",
    });

    expect(goClient.handleStripeCheckoutCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "hint-user", userEmail: "hint@example.test" }),
    );
  });

  it("treats empty metadata strings as absent and falls back to the hint", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(
      subscription({ metadata: { userId: "", userEmail: "" } }),
    );

    await syncSubscriptionFromStripe("sub_1", { userId: "hint-user", userEmail: "hint@example.test" });

    expect(goClient.handleStripeCheckoutCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "hint-user" }),
    );
  });

  it("prefers the subscription metadata over the hint", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription());

    await syncSubscriptionFromStripe("sub_1", { userId: "hint-user", userEmail: "hint@example.test" });

    expect(goClient.handleStripeCheckoutCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", userEmail: "buyer@example.test" }),
    );
  });

  it("represents a customer by its live subscription when an ended sibling is synced", async () => {
    // Cancelled, then resubscribed. The customer's row is keyed by customer, so
    // the ended subscription must not be written over the live one.
    stripeMock.subscriptions.retrieve.mockResolvedValue(
      subscription({ id: "sub_old", status: "canceled" }),
    );
    stripeMock.subscriptions.list.mockResolvedValue({
      data: [subscription({ id: "sub_new", status: "active" })],
    });

    const result = await syncSubscriptionFromStripe("sub_old");

    expect(stripeMock.subscriptions.list).toHaveBeenCalledWith({
      customer: "cus_1",
      status: "all",
      limit: 10,
    });
    expect(lastUpdate()).toMatchObject({
      stripeSubscriptionId: "sub_new",
      status: PROTO.ACTIVE,
      isDeleted: false,
    });
    expect(result).toMatchObject({ subscriptionId: "sub_new", status: "active" });
  });

  it("deletes a canceled subscription when the customer has no other live one", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(
      subscription({ id: "sub_old", status: "canceled" }),
    );
    stripeMock.subscriptions.list.mockResolvedValue({
      data: [subscription({ id: "sub_old", status: "canceled" })],
    });

    await syncSubscriptionFromStripe("sub_old");

    expect(lastUpdate()).toMatchObject({
      stripeSubscriptionId: "sub_old",
      status: PROTO.CANCELED,
      isDeleted: true,
    });
  });

  it("warns on a price that is not a configured Shorted plan, and still writes premium", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    stripeMock.subscriptions.retrieve.mockResolvedValue(
      subscription({
        items: {
          data: [
            {
              current_period_start: PERIOD_START,
              current_period_end: PERIOD_END,
              price: { id: "price_unknown" },
            },
          ],
        },
      }),
    );

    await syncSubscriptionFromStripe("sub_1");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("price_unknown"));
    expect(lastUpdate()).toMatchObject({ tier: PREMIUM_TIER });
    warn.mockRestore();
  });

  it("propagates a Stripe failure so the webhook returns 500", async () => {
    stripeMock.subscriptions.retrieve.mockRejectedValue(new Error("stripe down"));

    await expect(syncSubscriptionFromStripe("sub_1")).rejects.toThrow("stripe down");
    expect(goClient.handleStripeSubscriptionUpdated).not.toHaveBeenCalled();
  });
});

describe("planForPrice", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      STRIPE_PREMIUM_PRICE_ID: "price_premium",
      STRIPE_PRO_PRICE_ID: "price_legacy",
      STRIPE_API_ACCESS_PRICE_ID: "price_api_access",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("maps the configured prices, including the legacy premium env", () => {
    expect(planForPrice("price_premium")).toBe("premium");
    expect(planForPrice("price_legacy")).toBe("premium");
    expect(planForPrice("price_api_access")).toBe("api_access");
    expect(planForPrice("price_other")).toBe("unknown");
    expect(planForPrice(null)).toBe("unknown");
  });

  it("does not map anything to premium when the price env is unset", () => {
    delete process.env.STRIPE_PREMIUM_PRICE_ID;
    delete process.env.STRIPE_PRO_PRICE_ID;
    expect(planForPrice("price_premium")).toBe("unknown");
  });
});

describe("resolveSubscriptionIdForInvoice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads the subscription from parent.subscription_details", async () => {
    const invoice = {
      id: "in_1",
      customer: "cus_1",
      parent: { subscription_details: { subscription: "sub_parent" } },
    } as unknown as Stripe.Invoice;

    await expect(resolveSubscriptionIdForInvoice(invoice)).resolves.toBe("sub_parent");
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
  });

  it("accepts an expanded subscription object under the parent", async () => {
    const invoice = {
      id: "in_1",
      parent: { subscription_details: { subscription: { id: "sub_expanded" } } },
    } as unknown as Stripe.Invoice;

    await expect(resolveSubscriptionIdForInvoice(invoice)).resolves.toBe("sub_expanded");
  });

  it("falls back to the legacy top-level subscription field", async () => {
    const invoice = { id: "in_1", subscription: "sub_legacy" } as unknown as Stripe.Invoice;

    await expect(resolveSubscriptionIdForInvoice(invoice)).resolves.toBe("sub_legacy");
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
  });

  it("falls back to the customer's newest subscription that is not incomplete_expired", async () => {
    stripeMock.subscriptions.list.mockResolvedValue({
      data: [
        { id: "sub_expired", status: "incomplete_expired" },
        { id: "sub_newest_live", status: "active" },
        { id: "sub_older", status: "canceled" },
      ],
    });
    const invoice = { id: "in_1", customer: "cus_1" } as unknown as Stripe.Invoice;

    await expect(resolveSubscriptionIdForInvoice(invoice)).resolves.toBe("sub_newest_live");
    expect(stripeMock.subscriptions.list).toHaveBeenCalledWith({
      customer: "cus_1",
      status: "all",
      limit: 5,
    });
  });

  it("returns null for an invoice with no subscription and no customer", async () => {
    const invoice = { id: "in_1", customer: null } as unknown as Stripe.Invoice;

    await expect(resolveSubscriptionIdForInvoice(invoice)).resolves.toBeNull();
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
  });

  it("returns null when the customer has no subscriptions", async () => {
    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    const invoice = { id: "in_1", customer: "cus_1" } as unknown as Stripe.Invoice;

    await expect(resolveSubscriptionIdForInvoice(invoice)).resolves.toBeNull();
  });
});

describe("helpers", () => {
  it("classifies live Stripe statuses", () => {
    for (const status of ["active", "trialing", "past_due", "unpaid"]) {
      expect(isLiveStripeStatus(status)).toBe(true);
    }
    for (const status of ["canceled", "incomplete", "incomplete_expired", "paused"]) {
      expect(isLiveStripeStatus(status)).toBe(false);
    }
  });

  it("reads an id from either a string or an expanded object", () => {
    expect(idOf("cus_1")).toBe("cus_1");
    expect(idOf({ id: "cus_2" })).toBe("cus_2");
    expect(idOf(null)).toBeNull();
  });
});
