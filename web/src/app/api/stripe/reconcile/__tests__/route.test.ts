import fs from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";
import { GET, maxDuration } from "../route";
import { stripe } from "~/lib/stripe";
import { notifyOperator } from "~/@/lib/operator-notify";

jest.mock("~/lib/stripe", () => ({
  stripe: {
    subscriptions: { retrieve: jest.fn(), list: jest.fn() },
    invoices: { list: jest.fn(async () => ({ data: [] })) },
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
}));

const stripeMock = stripe as unknown as {
  subscriptions: { retrieve: jest.Mock; list: jest.Mock };
};
const goClient = (jest.requireMock("@connectrpc/connect") as {
  goClient: { handleStripeCheckoutCompleted: jest.Mock; handleStripeSubscriptionUpdated: jest.Mock };
}).goClient;
const notifyMock = notifyOperator as jest.Mock;

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

type FakeSubscription = ReturnType<typeof subscription>;

/** A subscription, owned by `customer` (default: its own customer). */
function subscription(
  id: string,
  status: string,
  options: { customer?: string; endedDaysAgo?: number | null; created?: number } = {},
) {
  const endedDaysAgo = options.endedDaysAgo ?? null;
  return {
    id,
    customer: options.customer ?? `cus_${id}`,
    status,
    created: options.created ?? NOW_SECONDS - 60 * DAY,
    cancel_at_period_end: false,
    ended_at: endedDaysAgo === null ? null : NOW_SECONDS - endedDaysAgo * DAY,
    canceled_at: null,
    metadata: { userId: `user-${id}`, userEmail: `${id}@example.test` },
    items: {
      data: [
        {
          current_period_start: NOW_SECONDS - 30 * DAY,
          current_period_end: NOW_SECONDS + 30 * DAY,
          price: { id: "price_premium", unit_amount: 400, currency: "aud" },
        },
      ],
    },
  };
}

/**
 * The account's subscriptions. The top-level list is iterated by the cron; the
 * per-customer list is what each customer sync reads. `failingCustomers` makes
 * that per-customer read throw.
 */
function listAccount(all: FakeSubscription[], failingCustomers: string[] = []) {
  stripeMock.subscriptions.list.mockImplementation((params: { customer?: string }) => {
    if (params.customer) {
      if (failingCustomers.includes(params.customer)) {
        return Promise.reject(new Error("stripe timeout for customer"));
      }
      return Promise.resolve({
        data: all.filter((candidate) => candidate.customer === params.customer),
        has_more: false,
      });
    }
    return {
      async *[Symbol.asyncIterator]() {
        for (const item of all) yield item;
      },
    };
  });
}

/** The customers the run wrote, in the order they were written. */
function writtenCustomers(): string[] {
  return goClient.handleStripeSubscriptionUpdated.mock.calls.map(
    (call) => (call[0] as { stripeCustomerId: string }).stripeCustomerId,
  );
}

// A plain object with real Headers: NextRequest's init drops headers under jsdom.
function request(authorization?: string): NextRequest {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return { headers } as unknown as NextRequest;
}

describe("GET /api/stripe/reconcile", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CRON_SECRET: "cron-secret",
      STRIPE_PREMIUM_PRICE_ID: "price_premium",
    };
    notifyMock.mockResolvedValue(true);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each([
    ["no credentials", undefined],
    ["a wrong secret", "Bearer not-the-secret"],
    ["the bare secret without the Bearer scheme", "cron-secret"],
  ])("refuses %s before touching Stripe", async (_label, authorization) => {
    const response = await GET(request(authorization));

    expect(response.status).toBe(401);
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  // The paid probe's cron door trims both sides of the comparison. These cases
  // keep this door doing the same, so one stored secret opens both or neither.
  it("accepts a secret stored with a trailing newline, as the probe's door does", async () => {
    process.env.CRON_SECRET = "cron-secret\n";
    listAccount([]);

    const response = await GET(request("Bearer cron-secret"));

    expect(response.status).toBe(200);
  });

  it("accepts a presented token with extra whitespace after the scheme", async () => {
    listAccount([]);

    const response = await GET(request("Bearer    cron-secret  "));

    expect(response.status).toBe(200);
  });

  it("refuses a blank presented token, and a blank configured secret, which disables the door", async () => {
    listAccount([]);
    expect((await GET(request("Bearer    "))).status).toBe(401);

    process.env.CRON_SECRET = "   ";
    expect((await GET(request("Bearer    "))).status).toBe(401);
    expect((await GET(request("Bearer cron-secret"))).status).toBe(401);
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
  });

  it("refuses the right token under another authorization scheme", async () => {
    listAccount([]);

    const response = await GET(request("Basic cron-secret"));

    expect(response.status).toBe(401);
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset, even with a bearer header", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(request("Bearer "));

    expect(response.status).toBe(401);
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
  });

  it("syncs customers with a live or recently ended subscription, and skips older ones", async () => {
    listAccount([
      subscription("active", "active"),
      subscription("trial", "trialing"),
      subscription("pastdue", "past_due"),
      subscription("unpaid", "unpaid"),
      subscription("recent_cancel", "canceled", { endedDaysAgo: 2 }),
      subscription("recent_expired", "incomplete_expired", { endedDaysAgo: 1 }),
      subscription("old_cancel", "canceled", { endedDaysAgo: 30 }),
      subscription("paused", "paused"),
    ]);

    const response = await GET(request("Bearer cron-secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      examined: 8,
      customers: 6,
      synced: 6,
      failed: 0,
      truncated: false,
    });
    expect(writtenCustomers().sort()).toEqual(
      [
        "cus_active",
        "cus_pastdue",
        "cus_recent_cancel",
        "cus_recent_expired",
        "cus_trial",
        "cus_unpaid",
      ].sort(),
    );
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("writes each customer once, from its best subscription, when it has several", async () => {
    // Two live subscriptions on one customer. Syncing each in turn would let
    // the last one written decide the row, so the cron writes the customer once.
    listAccount([
      subscription("unpaid_sub", "unpaid", { customer: "cus_1", created: NOW_SECONDS - 5 * DAY }),
      subscription("active_sub", "active", { customer: "cus_1", created: NOW_SECONDS - 60 * DAY }),
    ]);

    const response = await GET(request("Bearer cron-secret"));

    await expect(response.json()).resolves.toMatchObject({
      examined: 2,
      customers: 1,
      synced: 1,
      failed: 0,
    });
    expect(goClient.handleStripeSubscriptionUpdated).toHaveBeenCalledTimes(1);
    expect(goClient.handleStripeSubscriptionUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "active_sub",
        status: 1,
      }),
    );
  });

  it("never writes an unpaid customer's sibling over a paying user, whichever customer the run reaches first", async () => {
    // One user pays on cus_1 and has an old unpaid subscription on cus_2 with the
    // same metadata userId. The row may only ever be linked to cus_1.
    const payingOn1 = {
      ...subscription("pays_c1", "active", { customer: "cus_1", created: NOW_SECONDS - 60 * DAY }),
      metadata: { userId: "user-1", userEmail: "buyer@example.test" },
    };
    const unpaidOn2 = {
      ...subscription("unpaid_c2", "unpaid", { customer: "cus_2", created: NOW_SECONDS - 5 * DAY }),
      metadata: { userId: "user-1", userEmail: "buyer@example.test" },
    };
    listAccount([unpaidOn2, payingOn1]);

    await GET(request("Bearer cron-secret"));

    expect(goClient.handleStripeSubscriptionUpdated).toHaveBeenCalledTimes(2);
    const linked = goClient.handleStripeCheckoutCompleted.mock.calls.map(
      (call) => (call[0] as { stripeCustomerId: string }).stripeCustomerId,
    );
    expect(linked).toEqual(["cus_1"]);
  });

  it("counts a failed customer, keeps going, and alerts the operator with counts only", async () => {
    listAccount(
      [subscription("good", "active"), subscription("bad", "active")],
      ["cus_bad"],
    );

    const response = await GET(request("Bearer cron-secret"));

    await expect(response.json()).resolves.toEqual({
      examined: 2,
      customers: 2,
      synced: 1,
      failed: 1,
      truncated: false,
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const alert = notifyMock.mock.calls[0]?.[0] as { subject: string; text: string };
    expect(alert.subject).toBe("Shorted Stripe reconcile: 1 failed");
    expect(alert.text).toContain("Customers failed:       1");
    expect(alert.text).toContain("Listing truncated:      no");
    // Counts only: no customer ids, no addresses.
    expect(alert.text).not.toContain("cus_");
    expect(alert.text).not.toContain("@example.test");
  });

  it("stops at 500 examined, reports the run as truncated, and alerts the operator", async () => {
    listAccount(
      Array.from({ length: 501 }, (_, index) =>
        subscription(`old_${index}`, "canceled", { endedDaysAgo: 400 }),
      ),
    );

    const response = await GET(request("Bearer cron-secret"));

    await expect(response.json()).resolves.toEqual({
      examined: 500,
      customers: 0,
      synced: 0,
      failed: 0,
      truncated: true,
    });
    expect(goClient.handleStripeSubscriptionUpdated).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect((notifyMock.mock.calls[0]?.[0] as { subject: string }).subject).toBe(
      "Shorted Stripe reconcile: list truncated",
    );
  });

  it("alerts the operator with the failure and counts when both a customer and the listing truncate", async () => {
    listAccount(
      [
        subscription("bad", "active"),
        ...Array.from({ length: 500 }, (_, index) =>
          subscription(`old_${index}`, "canceled", { endedDaysAgo: 400 }),
        ),
      ],
      ["cus_bad"],
    );

    await GET(request("Bearer cron-secret"));

    expect((notifyMock.mock.calls[0]?.[0] as { subject: string }).subject).toBe(
      "Shorted Stripe reconcile: 1 failed, list truncated",
    );
  });

  it("does not alert on a clean run", async () => {
    listAccount([subscription("active", "active")]);

    const response = await GET(request("Bearer cron-secret"));

    expect(response.status).toBe(200);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("reports a listing failure as 503, alerts the operator, and does not leak the detail", async () => {
    stripeMock.subscriptions.list.mockImplementation(() => {
      throw new Error("secret internal detail");
    });

    const response = await GET(request("Bearer cron-secret"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "reconcile failed" });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const alert = notifyMock.mock.calls[0]?.[0] as { subject: string; text: string };
    expect(alert.subject).toBe("Shorted Stripe reconcile: run failed");
    expect(alert.text).not.toContain("secret internal detail");
  });
});

describe("reconcile deployment config", () => {
  const vercelJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../../../../vercel.json"), "utf8"),
  ) as { crons: Array<{ path: string; schedule: string }> };
  const rootVercelJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../../../../../vercel.json"), "utf8"),
  ) as { crons: Array<{ path: string; schedule: string }> };

  it("is scheduled daily in both the web and the root cron lists", () => {
    expect(vercelJson.crons).toContainEqual({
      path: "/api/stripe/reconcile",
      schedule: "40 18 * * *",
    });
    expect(rootVercelJson.crons).toEqual(vercelJson.crons);
  });

  it("exports the 60s budget the function-limit verifier pins", () => {
    expect(maxDuration).toBe(60);
  });
});
