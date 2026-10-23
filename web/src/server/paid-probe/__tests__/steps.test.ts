/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { SubscriptionInfo } from "~/app/actions/subscription";
import { extractLatestUserText, type ShortedChatUIMessage } from "@/hooks/chat-ui-message-adapter";

import { PAID_API_MONTHLY_LIMIT_MIN, PAID_PROBE_QUESTION } from "../constants";
import { chatRequestBody, runPaidProbe, type PaidProbeRun } from "../steps";
import { getMySubscription, mintApiToken } from "../shorts-client";
import type { ProbeContext } from "../types";

// The chat guard reads the real entitlement rule; everything behind it is stubbed.
jest.mock("~/server/auth", () => ({ auth: jest.fn() }));
jest.mock("~/app/actions/subscription", () => ({ getSubscriptionStatus: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ rateLimit: jest.fn() }));
jest.mock("../shorts-client", () => ({
  getMySubscription: jest.fn(),
  mintApiToken: jest.fn(),
}));

const TOKEN = "tok-probe-secret-value";
const CHAT_STEP = "chat";

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "..", "__fixtures__", name), "utf8");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const PAID: SubscriptionInfo = {
  status: "active",
  tier: "enterprise",
  hasActiveSubscription: true,
  isPremium: true,
  canMintTokens: true,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  features: [],
  requestsPerDay: 0,
};

interface Behaviour {
  chat?: () => Response;
  checkout?: () => Response;
  deleteConversation?: () => Response;
  getStock?: () => Response;
  gateChat?: () => Response;
}

/**
 * A fetch that answers each probe route the way a healthy app would, unless told
 * otherwise. /api/chat is one URL with two callers: the chat step (cookie present,
 * answers the stream) and the anonymous gate (no cookie, answers 401), so the fake
 * keys on the cookie, as the server does.
 */
function fakeFetch(behaviour: Behaviour = {}) {
  return jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.endsWith("/api/stripe/checkout")) {
      return (behaviour.checkout ?? (() => json(401, { error: "You must be signed in to subscribe" })))();
    }
    if (url.endsWith("/api/chat")) {
      if (headers.cookie === undefined) {
        return (behaviour.gateChat ?? (() => json(401, { error: "Authentication required" })))();
      }
      return (behaviour.chat ?? (() => sse(fixture("chat-stream-ok.sse"))))();
    }
    if (url.endsWith("/chat.v1.ChatService/DeleteConversation")) {
      return (behaviour.deleteConversation ?? (() => json(200, {})))();
    }
    if (url.endsWith("/shorts.v1alpha1.ShortedStocksService/GetStock")) {
      return (behaviour.getStock ?? (() => json(200, { productCode: "BHP" }, { "x-ratelimit-monthly-limit": "50000" })))();
    }
    throw new Error(`unexpected url in test: ${url}`);
  });
}

function context(fetchImpl: ReturnType<typeof fakeFetch>, overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    origin: "https://shorted.com.au",
    shortsApiUrl: "https://shorts.test",
    internalSecret: "internal-secret",
    fetch: fetchImpl as unknown as typeof fetch,
    sessionCookie: async () => ({ name: "__Secure-next-auth.session-token", value: "jwe-value" }),
    now: Date.now,
    secrets: ["internal-secret"],
    ...overrides,
  };
}

function byName(run: PaidProbeRun, name: string) {
  const step = run.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`no ${name} step`);
  return step;
}

beforeEach(() => {
  jest.mocked(getMySubscription).mockResolvedValue(PAID);
  jest.mocked(mintApiToken).mockResolvedValue(TOKEN);
});

describe("runPaidProbe", () => {
  it("passes every step on a healthy run, in order", async () => {
    const run = await runPaidProbe(context(fakeFetch()));

    expect(run.ok).toBe(true);
    expect(run.steps.map((step) => step.name)).toEqual(["entitlement", "chat", "api_token", "gates"]);
    expect(run.steps.every((step) => step.ok)).toBe(true);
    expect(byName(run, "entitlement").detail).toBe("status=active tier=enterprise");
    expect(byName(run, CHAT_STEP).detail).toBe("tools=query_short_positions; conversation deleted");
    expect(byName(run, "api_token").detail).toBe("GetStock 200, monthly limit 50000");
    expect(byName(run, "gates").detail).toContain("both 401");
  });

  it("keeps running the later steps after the entitlement step fails", async () => {
    jest.mocked(getMySubscription).mockResolvedValue({ ...PAID, status: "inactive", tier: "free", hasActiveSubscription: false, isPremium: false });
    const fetchImpl = fakeFetch();

    const run = await runPaidProbe(context(fetchImpl));

    expect(run.ok).toBe(false);
    const entitlement = byName(run, "entitlement");
    expect(entitlement.ok).toBe(false);
    expect(entitlement.detail).toBe("no paid chat entitlement (status=inactive, tier=free)");
    expect(byName(run, CHAT_STEP).ok).toBe(true);
    expect(byName(run, "api_token").ok).toBe(true);
    expect(byName(run, "gates").ok).toBe(true);
  });

  it("does not leak the internal secret or the minted token into any detail", async () => {
    jest.mocked(getMySubscription).mockRejectedValue(new Error("upstream said internal-secret is wrong"));
    jest.mocked(mintApiToken).mockResolvedValue(TOKEN);

    const run = await runPaidProbe(context(fakeFetch()));

    expect(byName(run, "entitlement").detail).toBe("Error: upstream said [redacted] is wrong");
    expect(JSON.stringify(run)).not.toContain("internal-secret");
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });
});

describe("chat step", () => {
  it("fails on the 2026-10-23 tool 403 even though the HTTP status is 200", async () => {
    const fetchImpl = fakeFetch({ chat: () => sse(fixture("chat-stream-tool-403.sse")) });

    const step = byName(await runPaidProbe(context(fetchImpl)), CHAT_STEP);

    expect(step.ok).toBe(false);
    expect(step.detail).toContain("tool failed: get_stock_details: RPC GetStockDetails returned 403");
  });

  it("still deletes the conversation after judging a failure", async () => {
    const fetchImpl = fakeFetch({ chat: () => sse(fixture("chat-stream-tool-403.sse")) });

    await runPaidProbe(context(fetchImpl));

    const deletes = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("DeleteConversation"));
    expect(deletes).toHaveLength(1);
    expect(JSON.parse(String((deletes[0]![1] as RequestInit).body))).toEqual({ conversationId: "conv-probe-403" });
  });

  it("fails on the error chunk and quotes its text", async () => {
    const step = byName(
      await runPaidProbe(context(fakeFetch({ chat: () => sse(fixture("chat-stream-error.sse")) }))),
      CHAT_STEP,
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("stream error: Chat is temporarily unavailable.");
  });

  it("fails on a non-200, quoting only the JSON error message", async () => {
    const step = byName(
      await runPaidProbe(
        context(fakeFetch({ chat: () => json(403, { error: "Premium subscription required" }) })),
      ),
      CHAT_STEP,
    );
    expect(step.detail).toBe("HTTP 403: Premium subscription required");
  });

  it("never echoes an HTML error page", async () => {
    const html = "<html><body>Cloudflare says no</body></html>";
    const step = byName(
      await runPaidProbe(context(fakeFetch({ chat: () => new Response(html, { status: 502 }) }))),
      CHAT_STEP,
    );
    expect(step.detail).toBe("HTTP 502");
    expect(step.detail).not.toContain("Cloudflare");
  });

  it("fails when the answer has no tool call", async () => {
    const noTools = [
      'data: {"type":"text-start","id":"a"}',
      'data: {"type":"text-delta","id":"a","delta":"Roughly 1.2%."}',
      'data: {"type":"text-end","id":"a"}',
      'data: {"type":"data-shorted-final","id":"shorted-final","data":{"conversationId":"conv-x"}}',
      "data: [DONE]",
      "",
    ].join("\n\n");

    const step = byName(await runPaidProbe(context(fakeFetch({ chat: () => sse(noTools) }))), CHAT_STEP);
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("no tool calls");
  });

  it("treats a failed conversation delete as a warning, not a failure", async () => {
    const step = byName(
      await runPaidProbe(context(fakeFetch({ deleteConversation: () => json(500, {}) }))),
      CHAT_STEP,
    );
    expect(step.ok).toBe(true);
    expect(step.detail).toBe("tools=query_short_positions; cleanup warning: HTTP 500");
  });

  it("sends the probe cookie, the app origin and the fixed question", async () => {
    const fetchImpl = fakeFetch();
    await runPaidProbe(context(fetchImpl));

    const chatCall = fetchImpl.mock.calls.find(([url]) => String(url) === "https://shorted.com.au/api/chat");
    const init = chatCall![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe("__Secure-next-auth.session-token=jwe-value");
    expect(headers.origin).toBe("https://shorted.com.au");
    expect(init.redirect).toBe("manual");
    const body = JSON.parse(String(init.body)) as { messages: ShortedChatUIMessage[] };
    expect(extractLatestUserText(body.messages)).toBe(PAID_PROBE_QUESTION);
  });

  it("fails when NEXTAUTH_SECRET is not configured, without reaching /api/chat", async () => {
    const fetchImpl = fakeFetch();
    const run = await runPaidProbe(
      context(fetchImpl, {
        sessionCookie: async () => {
          throw new Error("NEXTAUTH_SECRET is not configured");
        },
      }),
    );
    expect(byName(run, CHAT_STEP).detail).toBe("Error: NEXTAUTH_SECRET is not configured");
    const cookiedChatCalls = fetchImpl.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/api/chat") && (init?.headers as Record<string, string>).cookie !== undefined,
    );
    expect(cookiedChatCalls).toHaveLength(0);
  });
});

describe("api_token step", () => {
  it("fails a token on the free tier", async () => {
    const step = byName(
      await runPaidProbe(
        context(fakeFetch({ getStock: () => json(200, { productCode: "BHP" }, { "x-ratelimit-monthly-limit": "1000" }) })),
      ),
      "api_token",
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("token is not on a paid API tier (monthly limit 1000)");
  });

  it("fails when the monthly header is absent, as when rate limiting is off", async () => {
    const step = byName(await runPaidProbe(context(fakeFetch({ getStock: () => json(200, { productCode: "BHP" }) }))), "api_token");
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("token is not on a paid API tier (monthly limit absent)");
  });

  it("passes at the paid floor and sends the token as a Bearer credential", async () => {
    const fetchImpl = fakeFetch({
      getStock: () => json(200, { productCode: "BHP" }, { "x-ratelimit-monthly-limit": String(PAID_API_MONTHLY_LIMIT_MIN) }),
    });
    const step = byName(await runPaidProbe(context(fetchImpl)), "api_token");

    expect(step.ok).toBe(true);
    const stockCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/GetStock"));
    expect((stockCall![1] as RequestInit).headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it("fails when the answer is not a JSON object", async () => {
    const step = byName(
      await runPaidProbe(context(fakeFetch({ getStock: () => new Response("<html>", { status: 200, headers: { "x-ratelimit-monthly-limit": "50000" } }) }))),
      "api_token",
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("GetStock with the token returned no JSON object");
  });
});

describe("gates step", () => {
  it("fails when /api/chat answers a redirect instead of a 401", async () => {
    const step = byName(
      await runPaidProbe(context(fakeFetch({ gateChat: () => new Response(null, { status: 307, headers: { location: "/signin" } }) }))),
      "gates",
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("/api/chat answered 307, want 401");
  });

  it("fails when the checkout route answers 200 to an anonymous caller", async () => {
    const step = byName(
      await runPaidProbe(context(fakeFetch({ checkout: () => json(200, { url: "https://checkout.stripe.com/x" }) }))),
      "gates",
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("/api/stripe/checkout answered 200, want 401");
  });

  it("sends the anonymous gate a real user message and no cookie", async () => {
    const fetchImpl = fakeFetch({ gateChat: () => json(401, { error: "Authentication required" }) });
    await runPaidProbe(context(fetchImpl));

    const gateCall = fetchImpl.mock.calls.find(
      ([url, init]) =>
        String(url) === "https://shorted.com.au/api/chat" &&
        (init?.headers as Record<string, string> | undefined)?.cookie === undefined,
    );
    const init = gateCall![1] as RequestInit;
    expect((init.headers as Record<string, string>).cookie).toBeUndefined();
    const body = JSON.parse(String(init.body)) as { messages: ShortedChatUIMessage[] };
    expect(extractLatestUserText(body.messages)).toBe(PAID_PROBE_QUESTION);
  });
});

describe("chatRequestBody", () => {
  it("is the shape the app's own reader expects", () => {
    expect(extractLatestUserText(chatRequestBody().messages as ShortedChatUIMessage[])).toBe(PAID_PROBE_QUESTION);
  });
});
