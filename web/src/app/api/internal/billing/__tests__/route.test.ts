import type { NextRequest } from "next/server";
import { POST } from "../route";
import { stripe } from "~/lib/stripe";

jest.mock("~/lib/stripe", () => ({
  stripe: {
    customers: { list: jest.fn(), retrieve: jest.fn() },
    subscriptions: { list: jest.fn(), retrieve: jest.fn() },
    invoices: { list: jest.fn() },
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

const stripeMock = stripe as unknown as {
  customers: { list: jest.Mock; retrieve: jest.Mock };
  subscriptions: { list: jest.Mock; retrieve: jest.Mock };
  invoices: { list: jest.Mock };
};
const goClient = (jest.requireMock("@connectrpc/connect") as {
  goClient: { handleStripeSubscriptionUpdated: jest.Mock };
}).goClient;

const CREATED = Math.floor(Date.UTC(2026, 9, 1) / 1000);
const PERIOD_END = Math.floor(Date.UTC(2026, 10, 23) / 1000);

/** Everything a Stripe customer carries that the admin read must never return. */
const PII_CUSTOMER = {
  id: "cus_1",
  object: "customer",
  created: CREATED,
  email: "jane@example.test",
  name: "Jane Citizen",
  phone: "+61400000000",
  address: { line1: "1 Example St", city: "Sydney" },
  shipping: { name: "Jane Citizen", address: { line1: "1 Example St" } },
  invoice_settings: { default_payment_method: "pm_secret" },
  deleted: undefined,
};

const SUBSCRIPTION = {
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  currency: "aud",
  cancel_at_period_end: false,
  created: CREATED,
  metadata: { userId: "firebase-uid-1", userEmail: "jane@example.test" },
  items: {
    data: [
      {
        current_period_start: PERIOD_END - 30 * 86400,
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
};

const INVOICE = {
  id: "in_1",
  status: "paid",
  amount_paid: 400,
  currency: "aud",
  created: CREATED,
  status_transitions: { paid_at: CREATED + 60 },
  hosted_invoice_url: "https://invoice.stripe.com/i/secret",
  invoice_pdf: "https://pay.stripe.com/invoice.pdf",
  customer_name: "Jane Citizen",
  customer_address: { line1: "1 Example St" },
};

function request(body: unknown, headers: Record<string, string> = { "x-internal-secret": "internal-secret" }): NextRequest {
  return {
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as NextRequest;
}

async function call(body: unknown) {
  const response = await POST(request(body));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

/** Every key at any depth, so a leak inside a nested object is caught too. */
function keysDeep(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => keysDeep(item, into));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.push(key);
      keysDeep(child, into);
    }
  }
  return into;
}

const FORBIDDEN_KEYS = [
  "hosted_invoice_url",
  "invoice_pdf",
  "payment_method",
  "card",
  "address",
  "phone",
  "name",
  "shipping",
  "billing_details",
];

describe("POST /api/internal/billing", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, INTERNAL_SERVICE_SECRET: "internal-secret", STRIPE_PREMIUM_PRICE_ID: "price_premium" };
    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.invoices.list.mockResolvedValue({ data: [] });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each([
    ["no secret", {}],
    ["a wrong secret", { "x-internal-secret": "wrong" }],
  ])("refuses %s before reading Stripe", async (_label, headers) => {
    const response = await POST(request({ action: "customer", email: "jane@example.test" }, headers));

    expect(response.status).toBe(403);
    expect(stripeMock.customers.list).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: "customer" }],
    [{ action: "customer", email: "not-an-email" }],
    [{ action: "customer", customerId: "bad id; drop" }],
    [{ action: "reconcile" }],
    [{ action: "reconcile", customerId: "xyz" }],
    [{ action: "bogus" }],
    [{}],
  ])("rejects bad input %j with 400", async (body) => {
    const result = await call(body);

    expect(result.status).toBe(400);
    expect(stripeMock.customers.list).not.toHaveBeenCalled();
    expect(stripeMock.customers.retrieve).not.toHaveBeenCalled();
  });

  it("describes a customer found by email, without any personal or payment detail", async () => {
    stripeMock.customers.list.mockResolvedValue({ data: [PII_CUSTOMER] });
    stripeMock.subscriptions.list.mockResolvedValue({ data: [SUBSCRIPTION] });
    stripeMock.invoices.list.mockResolvedValue({ data: [INVOICE] });

    const result = await call({ action: "customer", email: "jane@example.test" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      customer: { id: "cus_1", created: new Date(CREATED * 1000).toISOString() },
      subscriptions: [
        {
          id: "sub_1",
          status: "active",
          tier: "premium",
          priceId: "price_premium",
          amount: 400,
          currency: "aud",
          interval: "month",
          currentPeriodStart: new Date((PERIOD_END - 30 * 86400) * 1000).toISOString(),
          currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString(),
          cancelAtPeriodEnd: false,
          created: new Date(CREATED * 1000).toISOString(),
          metadataUserId: "firebase-uid-1",
        },
      ],
      latestInvoice: {
        status: "paid",
        amountPaid: 400,
        currency: "aud",
        created: new Date(CREATED * 1000).toISOString(),
        paidAt: new Date((CREATED + 60) * 1000).toISOString(),
      },
    });

    const keys = keysDeep(result.body);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
    expect(JSON.stringify(result.body)).not.toContain("Jane Citizen");
    expect(JSON.stringify(result.body)).not.toContain("1 Example St");
    expect(JSON.stringify(result.body)).not.toContain("invoice.stripe.com");
    expect(result.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports an address that matches two customers without choosing one", async () => {
    stripeMock.customers.list.mockResolvedValue({
      data: [{ id: "cus_a", created: CREATED }, { id: "cus_b", created: CREATED }],
    });

    const result = await call({ action: "customer", email: "shared@example.test" });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      customer: null,
      ambiguous: true,
      customerIds: ["cus_a", "cus_b"],
      subscriptions: [],
    });
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
  });

  it("returns no customer for an unknown address", async () => {
    stripeMock.customers.list.mockResolvedValue({ data: [] });

    const result = await call({ action: "customer", email: "nobody@example.test" });

    expect(result.body).toEqual({ customer: null, subscriptions: [], latestInvoice: null });
    expect(stripeMock.invoices.list).not.toHaveBeenCalled();
  });

  it("looks a customer up by id, and treats a deleted one as absent", async () => {
    stripeMock.customers.retrieve.mockResolvedValue({ id: "cus_1", deleted: true });

    const result = await call({ action: "customer", customerId: "cus_1" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ customer: null, subscriptions: [], latestInvoice: null });
  });

  it("treats a missing customer id as absent rather than as an error", async () => {
    stripeMock.customers.retrieve.mockRejectedValue(
      Object.assign(new Error("No such customer"), { code: "resource_missing" }),
    );

    const result = await call({ action: "customer", customerId: "cus_gone" });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ customer: null });
  });

  it("lists every live subscription, with the email from metadata or the expanded customer", async () => {
    stripeMock.subscriptions.list.mockImplementation((params: { status: string }) => {
      const items: unknown[] = [];
      if (params.status === "active") {
        items.push(SUBSCRIPTION);
      }
      if (params.status === "past_due") {
        items.push({
          ...SUBSCRIPTION,
          id: "sub_2",
          status: "past_due",
          metadata: {},
          customer: { id: "cus_2", email: "expanded@example.test", name: "Secret" },
        });
      }
      return {
        async *[Symbol.asyncIterator]() {
          for (const item of items) yield item;
        },
      };
    });

    const result = await call({ action: "alive" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      subscriptions: [
        {
          customerId: "cus_1",
          subscriptionId: "sub_1",
          status: "active",
          tier: "premium",
          currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString(),
          cancelAtPeriodEnd: false,
          metadataUserId: "firebase-uid-1",
          email: "jane@example.test",
        },
        {
          customerId: "cus_2",
          subscriptionId: "sub_2",
          status: "past_due",
          tier: "premium",
          currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString(),
          cancelAtPeriodEnd: false,
          metadataUserId: null,
          email: "expanded@example.test",
        },
      ],
      truncated: false,
    });
    expect(JSON.stringify(result.body)).not.toContain("Secret");
    // Only the live statuses are listed.
    const statuses = stripeMock.subscriptions.list.mock.calls.map((call) => call[0].status);
    expect(statuses.sort()).toEqual(["active", "past_due", "trialing", "unpaid"]);
  });

  it("caps the alive list at 500 and reports the truncation", async () => {
    const many = Array.from({ length: 501 }, (_, index) => ({
      ...SUBSCRIPTION,
      id: `sub_${index}`,
    }));
    stripeMock.subscriptions.list.mockImplementation((params: { status: string }) => ({
      async *[Symbol.asyncIterator]() {
        if (params.status === "active") for (const item of many) yield item;
      },
    }));

    const result = await call({ action: "alive" });

    expect(result.body).toMatchObject({ truncated: true });
    expect((result.body as { subscriptions: unknown[] }).subscriptions).toHaveLength(500);
  });

  it("re-syncs each of a customer's subscriptions and returns the summaries", async () => {
    // The Stripe SDK's list is both awaitable (`.data`) and async-iterable.
    const subscriptions = [SUBSCRIPTION, { ...SUBSCRIPTION, id: "sub_old" }];
    stripeMock.subscriptions.list.mockImplementation(() => ({
      data: subscriptions,
      async *[Symbol.asyncIterator]() {
        for (const item of subscriptions) yield item;
      },
    }));
    stripeMock.subscriptions.retrieve.mockImplementation(async (id: string) => ({
      ...SUBSCRIPTION,
      id,
      status: id === "sub_old" ? "canceled" : "active",
    }));

    const result = await call({ action: "reconcile", customerId: "cus_1" });

    expect(result.status).toBe(200);
    // The ended subscription is represented by the customer's live one, so
    // syncing it cannot flip the customer to canceled.
    expect(result.body).toMatchObject({
      customerId: "cus_1",
      subscriptions: [
        { subscriptionId: "sub_1", status: "active", tier: "premium", ensuredRow: true },
        { subscriptionId: "sub_1", status: "active", tier: "premium", ensuredRow: true },
      ],
    });
    expect(goClient.handleStripeSubscriptionUpdated).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result.body)).not.toContain("jane@example.test");
  });

  it("reports a Stripe failure as 503 without the underlying message", async () => {
    stripeMock.customers.list.mockRejectedValue(new Error("upstream secret detail"));

    const result = await call({ action: "customer", email: "jane@example.test" });

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "lookup failed" });
  });
});
