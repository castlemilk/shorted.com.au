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

describe("GET /api/stripe/reconcile Telesis check-in", () => {
  const CHECKIN = "https://api.telesis.dev/v1/cron/reconcile-test-token";
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  // A plain object: only ok, status and text() are read, so no Response class is needed.
  const acceptedResponse = async () => ({ ok: true, status: 204, text: async () => "" });

  function posted(): Array<{ url: string; body: { duration_ms: number; terminal_reason: string } }> {
    return fetchMock.mock.calls.map((call: unknown[]) => ({
      url: String(call[0]),
      body: JSON.parse(String((call[1] as RequestInit).body)),
    }));
  }

  // jsdom has no AbortSignal.timeout, which the check-in sets as its timeout. Without
  // this shim every check-in would fail before fetch and the tests would pass
  // vacuously. The runtime (Node) has it, so the shim lives only in this block.
  let addedTimeout = false;

  beforeEach(() => {
    jest.clearAllMocks();
    if (typeof AbortSignal.timeout !== "function") {
      Object.defineProperty(AbortSignal, "timeout", {
        value: () => new AbortController().signal,
        configurable: true,
        writable: true,
      });
      addedTimeout = true;
    }
    fetchMock = jest.fn(acceptedResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.CRON_SECRET = "cron-secret";
    process.env.STRIPE_PREMIUM_PRICE_ID = "price_premium";
    process.env.TELESIS_STRIPE_RECONCILE_CHECKIN = CHECKIN;
    notifyMock.mockResolvedValue(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.TELESIS_STRIPE_RECONCILE_CHECKIN;
    if (addedTimeout) {
      delete (AbortSignal as unknown as { timeout?: unknown }).timeout;
      addedTimeout = false;
    }
  });

  it("checks in /complete on a clean run, with the counts in terminal_reason", async () => {
    listAccount([subscription("active", "active")]);

    await GET(request("Bearer cron-secret"));

    expect(posted()).toHaveLength(1);
    expect(posted()[0]!.url).toBe(`${CHECKIN}/complete`);
    expect(posted()[0]!.body.terminal_reason).toBe("examined=1 customers=1 synced=1 failed=0 truncated=no");
    expect(posted()[0]!.body.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("checks in /fail with the failure count when a customer fails", async () => {
    listAccount([subscription("good", "active"), subscription("bad", "active")], ["cus_bad"]);

    await GET(request("Bearer cron-secret"));

    expect(posted()[0]!.url).toBe(`${CHECKIN}/fail`);
    expect(posted()[0]!.body.terminal_reason).toContain("failed=1");
  });

  it("checks in /fail with truncated=yes when the listing is cut at 500", async () => {
    listAccount(
      Array.from({ length: 501 }, (_, index) => subscription(`old_${index}`, "canceled", { endedDaysAgo: 400 })),
    );

    await GET(request("Bearer cron-secret"));

    expect(posted()[0]!.url).toBe(`${CHECKIN}/fail`);
    expect(posted()[0]!.body.terminal_reason).toContain("truncated=yes");
  });

  it("checks in /fail when the run cannot list subscriptions at all", async () => {
    stripeMock.subscriptions.list.mockImplementation(() => {
      throw new Error("secret internal detail");
    });

    const response = await GET(request("Bearer cron-secret"));

    expect(response.status).toBe(503);
    expect(posted()[0]!.url).toBe(`${CHECKIN}/fail`);
    expect(posted()[0]!.body.terminal_reason).toBe("run failed: could not list subscriptions");
  });

  it("sends nothing when the variable is unset", async () => {
    delete process.env.TELESIS_STRIPE_RECONCILE_CHECKIN;
    listAccount([subscription("active", "active")]);

    const response = await GET(request("Bearer cron-secret"));

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a Telesis check-in URL, sends nothing, and never logs the value", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.TELESIS_STRIPE_RECONCILE_CHECKIN = "https://evil.example/leak-token";
    listAccount([subscription("active", "active")]);

    const response = await GET(request("Bearer cron-secret"));

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("TELESIS_STRIPE_RECONCILE_CHECKIN");
    expect(logged).not.toContain("evil.example");
    expect(logged).not.toContain("leak-token");
    warn.mockRestore();
  });

  it("keeps the run's answer when the check-in fails, and never logs the URL", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    // A fetch TypeError can carry the URL in its message. It must not reach a log.
    fetchMock.mockImplementation(async (url: string) => {
      throw new TypeError(`Failed to fetch ${url}`);
    });
    listAccount([subscription("active", "active")]);

    const response = await GET(request("Bearer cron-secret"));

    expect(response.status).toBe(200);
    const everything = JSON.stringify([warn.mock.calls, error.mock.calls, log.mock.calls]);
    expect(everything).not.toContain("reconcile-test-token");
    expect(everything).toContain("check-in stripe-reconcile failed: TypeError");
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
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
