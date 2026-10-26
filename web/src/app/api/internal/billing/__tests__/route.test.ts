import type { NextRequest } from "next/server";
import { POST, maxDuration } from "../route";
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
          representative: true,
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

  it("re-syncs the customer once, from its best subscription", async () => {
    // Two subscriptions on one customer: the active one must be the single write.
    const active = { ...SUBSCRIPTION, id: "sub_1", status: "active", created: CREATED + 100 };
    const ended = { ...SUBSCRIPTION, id: "sub_old", status: "canceled", created: CREATED };
    stripeMock.subscriptions.list.mockResolvedValue({
      data: [ended, active],
      has_more: false,
    });

    const result = await call({ action: "reconcile", customerId: "cus_1" });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      customerId: "cus_1",
      subscription: {
        subscriptionId: "sub_1",
        status: "active",
        tier: "premium",
        ensuredRow: true,
      },
    });
    expect(goClient.handleStripeSubscriptionUpdated).toHaveBeenCalledTimes(1);
    expect(goClient.handleStripeSubscriptionUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ stripeSubscriptionId: "sub_1", isDeleted: false }),
    );
    expect(JSON.stringify(result.body)).not.toContain("jane@example.test");
  });

  it("returns a null subscription and writes nothing for a customer with none", async () => {
    stripeMock.subscriptions.list.mockResolvedValue({ data: [], has_more: false });

    const result = await call({ action: "reconcile", customerId: "cus_1" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ customerId: "cus_1", subscription: null });
    expect(goClient.handleStripeSubscriptionUpdated).not.toHaveBeenCalled();
  });

  describe("a customer with more subscriptions than one page", () => {
    /** Stripe's list for one customer: honours `limit` up to `pageSize`, and `starting_after`. */
    function pagedSubscriptions(all: unknown[], pageSize = 100) {
      stripeMock.subscriptions.list.mockImplementation(
        async (params: { customer?: string; limit?: number; starting_after?: string }) => {
          const mine = all.filter(
            (candidate) => (candidate as { customer: string }).customer === params.customer,
          );
          const start = params.starting_after
            ? mine.findIndex((candidate) => (candidate as { id: string }).id === params.starting_after) + 1
            : 0;
          const size = Math.min(params.limit ?? 10, pageSize);
          return {
            data: mine.slice(start, start + size),
            has_more: start + size < mine.length,
          };
        },
      );
    }

    /** Twelve subscriptions newest first. Ten ended ones sit ahead of the live one. */
    function twelveWithLiveEleventh() {
      const ended = Array.from({ length: 10 }, (_, index) => ({
        ...SUBSCRIPTION,
        id: `sub_ended_${index}`,
        status: "canceled",
        created: CREATED + 1000 - index,
      }));
      const live = { ...SUBSCRIPTION, id: "sub_live", status: "active", created: CREATED + 500 };
      const oldest = { ...SUBSCRIPTION, id: "sub_oldest", status: "canceled", created: CREATED };
      // The live one is the 11th in the listing.
      return [...ended, live, oldest];
    }

    it("shows the live subscription the 11th position, which a ten-item window would miss", async () => {
      pagedSubscriptions(twelveWithLiveEleventh());
      stripeMock.customers.list.mockResolvedValue({ data: [PII_CUSTOMER] });

      const result = await call({ action: "customer", email: "jane@example.test" });

      const listed = (result.body as { subscriptions: Array<{ id: string; status: string; representative: boolean }> })
        .subscriptions;
      expect(listed).toHaveLength(12);
      expect(listed.find((candidate) => candidate.id === "sub_live")).toMatchObject({
        status: "active",
        representative: true,
      });
      expect(listed.filter((candidate) => candidate.representative)).toHaveLength(1);
    });

    it("reads every page of the customer's subscriptions, not only the first", async () => {
      // A server page cap of 5 forces three pages for twelve subscriptions.
      pagedSubscriptions(twelveWithLiveEleventh(), 5);
      stripeMock.customers.list.mockResolvedValue({ data: [PII_CUSTOMER] });

      const result = await call({ action: "customer", email: "jane@example.test" });

      expect((result.body as { subscriptions: unknown[] }).subscriptions).toHaveLength(12);
      expect(stripeMock.subscriptions.list).toHaveBeenCalledTimes(3);
      expect(result.body).toMatchObject({
        subscriptions: expect.arrayContaining([
          expect.objectContaining({ id: "sub_live", representative: true }),
        ]),
      });
    });

    it("marks the representative by the sync's rule, so an unpaid sibling is not chosen over an active one", async () => {
      const unpaid = { ...SUBSCRIPTION, id: "sub_unpaid", status: "unpaid", created: CREATED + 900 };
      const active = { ...SUBSCRIPTION, id: "sub_active", status: "active", created: CREATED };
      pagedSubscriptions([unpaid, active]);
      stripeMock.customers.list.mockResolvedValue({ data: [PII_CUSTOMER] });

      const result = await call({ action: "customer", email: "jane@example.test" });

      const listed = (result.body as { subscriptions: Array<{ id: string; representative: boolean }> })
        .subscriptions;
      expect(listed.find((candidate) => candidate.id === "sub_active")?.representative).toBe(true);
      expect(listed.find((candidate) => candidate.id === "sub_unpaid")?.representative).toBe(false);
    });
  });

  it("reports a Stripe failure as 503 without the underlying message", async () => {
    stripeMock.customers.list.mockRejectedValue(new Error("upstream secret detail"));

    const result = await call({ action: "customer", email: "jane@example.test" });

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "lookup failed" });
  });
});

describe("customer email lookup", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, INTERNAL_SERVICE_SECRET: "internal-secret", STRIPE_PREMIUM_PRICE_ID: "price_premium" };
    stripeMock.subscriptions.list.mockResolvedValue({ data: [], has_more: false });
    stripeMock.invoices.list.mockResolvedValue({ data: [] });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  /** Stripe's filter is case-sensitive: each address matches only its own spelling. */
  function customersStoredAs(stored: Record<string, Array<{ id: string; created: number }>>) {
    stripeMock.customers.list.mockImplementation(async (params: { email: string }) => ({
      data: stored[params.email] ?? [],
    }));
  }

  it("searches the address as given, once, when it is already lowercase", async () => {
    stripeMock.customers.list.mockResolvedValue({ data: [PII_CUSTOMER] });

    const result = await call({ action: "customer", email: "jane@example.test" });

    expect(result.body).toMatchObject({ customer: { id: "cus_1" } });
    expect(stripeMock.customers.list).toHaveBeenCalledTimes(1);
    expect(stripeMock.customers.list).toHaveBeenCalledWith({
      email: "jane@example.test",
      limit: 3,
    });
  });

  it("finds a customer stored in lowercase when the address is typed in mixed case", async () => {
    customersStoredAs({ "jane@example.test": [{ id: "cus_1", created: CREATED }] });

    const result = await call({ action: "customer", email: "Jane@Example.test" });

    expect(stripeMock.customers.list.mock.calls.map(([params]) => params.email)).toEqual([
      "Jane@Example.test",
      "jane@example.test",
    ]);
    expect(result.body).toMatchObject({ customer: { id: "cus_1" } });
  });

  it("reports two customers that differ only by case as ambiguous, without choosing one", async () => {
    customersStoredAs({
      "Jane@Example.test": [{ id: "cus_mixed", created: CREATED }],
      "jane@example.test": [{ id: "cus_lower", created: CREATED }],
    });

    const result = await call({ action: "customer", email: "Jane@Example.test" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      customer: null,
      subscriptions: [],
      latestInvoice: null,
      ambiguous: true,
      customerIds: ["cus_mixed", "cus_lower"],
    });
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
  });

  it("counts a customer that both searches return once, so it is not reported as ambiguous", async () => {
    stripeMock.customers.list.mockResolvedValue({ data: [PII_CUSTOMER] });

    const result = await call({ action: "customer", email: "Jane@Example.test" });

    expect(stripeMock.customers.list).toHaveBeenCalledTimes(2);
    expect(result.body).toMatchObject({ customer: { id: "cus_1" } });
    expect(result.body).not.toHaveProperty("ambiguous");
  });

  it("returns no customer when neither spelling matches", async () => {
    customersStoredAs({});

    const result = await call({ action: "customer", email: "Nobody@Example.test" });

    expect(result.body).toEqual({ customer: null, subscriptions: [], latestInvoice: null });
  });

  it("keeps the amount null when the price has no unit amount", async () => {
    stripeMock.customers.list.mockResolvedValue({ data: [PII_CUSTOMER] });
    stripeMock.subscriptions.list.mockResolvedValue({
      data: [{ ...SUBSCRIPTION, items: { data: [{ ...SUBSCRIPTION.items.data[0], price: { id: "price_premium", unit_amount: null, currency: "aud", recurring: { interval: "month" } } }] } }],
      has_more: false,
    });

    const result = await call({ action: "customer", email: "jane@example.test" });

    expect(result.body).toMatchObject({ subscriptions: [{ amount: null }] });
  });

  it("carries its own 30 second budget, above the Go caller's 20 second timeout", () => {
    expect(maxDuration).toBe(30);
  });
});

