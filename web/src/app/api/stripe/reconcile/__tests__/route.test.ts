import fs from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";
import { GET, maxDuration } from "../route";
import { stripe } from "~/lib/stripe";

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

const stripeMock = stripe as unknown as {
  subscriptions: { retrieve: jest.Mock; list: jest.Mock };
};
const goClient = (jest.requireMock("@connectrpc/connect") as {
  goClient: { handleStripeSubscriptionUpdated: jest.Mock };
}).goClient;

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

function subscription(id: string, status: string, endedDaysAgo: number | null = null) {
  return {
    id,
    customer: `cus_${id}`,
    status,
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

/** Lists the account's subscriptions; a per-customer lookup returns none. */
function listAll(all: unknown[]) {
  stripeMock.subscriptions.list.mockImplementation((params: { customer?: string }) => {
    if (params.customer) return Promise.resolve({ data: [] });
    return {
      async *[Symbol.asyncIterator]() {
        for (const item of all) yield item;
      },
    };
  });
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
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset, even with a bearer header", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(request("Bearer "));

    expect(response.status).toBe(401);
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
  });

  it("syncs live subscriptions and recently ended ones, and skips older ended ones", async () => {
    const all = [
      subscription("active", "active"),
      subscription("trial", "trialing"),
      subscription("pastdue", "past_due"),
      subscription("unpaid", "unpaid"),
      subscription("recent_cancel", "canceled", 2),
      subscription("recent_expired", "incomplete_expired", 1),
      subscription("old_cancel", "canceled", 30),
      subscription("paused", "paused"),
    ];
    listAll(all);
    stripeMock.subscriptions.retrieve.mockImplementation(async (id: string) =>
      all.find((candidate) => candidate.id === id),
    );

    const response = await GET(request("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ examined: 8, synced: 6, failed: 0, truncated: false });
    const synced = stripeMock.subscriptions.retrieve.mock.calls.map((call) => call[0]).sort();
    expect(synced).toEqual(
      ["active", "pastdue", "recent_cancel", "recent_expired", "trial", "unpaid"].sort(),
    );
    expect(goClient.handleStripeSubscriptionUpdated).toHaveBeenCalledTimes(6);
  });

  it("counts a failed sync and keeps going", async () => {
    const all = [subscription("good", "active"), subscription("bad", "active")];
    listAll(all);
    stripeMock.subscriptions.retrieve.mockImplementation(async (id: string) => {
      if (id === "bad") throw new Error("stripe timeout");
      return all.find((candidate) => candidate.id === id);
    });

    const response = await GET(request("Bearer cron-secret"));

    await expect(response.json()).resolves.toEqual({
      examined: 2,
      synced: 1,
      failed: 1,
      truncated: false,
    });
  });

  it("stops at 500 examined and reports the run as truncated", async () => {
    const all = Array.from({ length: 501 }, (_, index) =>
      subscription(`old_${index}`, "canceled", 400),
    );
    listAll(all);

    const response = await GET(request("Bearer cron-secret"));

    await expect(response.json()).resolves.toEqual({
      examined: 500,
      synced: 0,
      failed: 0,
      truncated: true,
    });
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("reports a Stripe listing failure as 503 without leaking detail", async () => {
    stripeMock.subscriptions.list.mockImplementation(() => {
      throw new Error("secret internal detail");
    });

    const response = await GET(request("Bearer cron-secret"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "reconcile failed" });
  });
});

describe("reconcile deployment config", () => {
  const vercelJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../../../../vercel.json"), "utf8"),
  ) as {
    crons: Array<{ path: string; schedule: string }>;
    functions: Record<string, { maxDuration: number }>;
  };

  it("is scheduled daily", () => {
    expect(vercelJson.crons).toContainEqual({
      path: "/api/stripe/reconcile",
      schedule: "40 18 * * *",
    });
  });

  it("declares its own function budget ahead of the catch-all, which would otherwise win", () => {
    // Vercel applies the first functions key whose glob matches, in object order.
    const keys = Object.keys(vercelJson.functions);
    const own = keys.indexOf("src/app/api/stripe/reconcile/route.ts");
    const catchAll = keys.indexOf("src/app/**/*");
    expect(own).toBeGreaterThanOrEqual(0);
    expect(catchAll).toBeGreaterThan(own);
    expect(vercelJson.functions[keys[own]!]).toEqual({ maxDuration: 60 });
  });

  it("exports the same budget from the route", () => {
    expect(maxDuration).toBe(60);
  });
});
