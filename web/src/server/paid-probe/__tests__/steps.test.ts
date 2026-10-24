/** @jest-environment node */
import type { SubscriptionInfo } from "~/app/actions/subscription";
import { extractLatestUserText, type ShortedChatUIMessage } from "@/hooks/chat-ui-message-adapter";

import {
  CHAT_TURN_BUDGET_MS,
  CHECKIN_BUDGET_MS,
  PAID_API_MONTHLY_LIMIT_MIN,
  PAID_PROBE_QUESTION,
  PROBE_WORST_CASE_CEILING_MS,
  STEP_BUDGET_MS,
} from "../constants";
import { getMySubscription, mintApiToken } from "../shorts-client";
import {
  chatRequestBody,
  PROBE_STEP_BUDGETS,
  PROBE_STEP_NAMES,
  probeWorstCaseMs,
  runPaidProbe,
  type PaidProbeRun,
} from "../steps";
import { ProbeFailure, type ProbeContext } from "../types";
import { cutOffStream, fixture, json, sseResponse, streamOf } from "./helpers";

// The chat guard reads the real entitlement rule; everything behind it is stubbed.
jest.mock("~/server/auth", () => ({ auth: jest.fn() }));
jest.mock("~/app/actions/subscription", () => ({ getSubscriptionStatus: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ rateLimit: jest.fn() }));
jest.mock("../shorts-client", () => ({
  getMySubscription: jest.fn(),
  mintApiToken: jest.fn(),
}));

const TOKEN = "tok-probe-secret-value";
const COOKIE_VALUE = "jwe-value";
const PUBLIC_GET_STOCK = "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStock";
const DELETE_CONVERSATION = "https://shorted.com.au/chat.v1.ChatService/DeleteConversation";

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

/** A healthy answer from the public host: origin-passed-through, paid monthly limit. */
function paidStock(): Response {
  return json(200, { productCode: "BHP" }, { "x-ratelimit-monthly-limit": "50000", "x-shorted-cache": "BYPASS" });
}

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
      return (behaviour.chat ?? (() => sseResponse(fixture("chat-stream-ok.sse"))))();
    }
    if (url.endsWith("/chat.v1.ChatService/DeleteConversation")) {
      return (behaviour.deleteConversation ?? (() => json(200, {})))();
    }
    if (url.endsWith("/shorts.v1alpha1.ShortedStocksService/GetStock")) {
      return (behaviour.getStock ?? paidStock)();
    }
    throw new Error(`unexpected url in test: ${url}`);
  });
}

function context(fetchImpl: ReturnType<typeof fakeFetch>, overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    origin: { trusted: true, value: "https://shorted.com.au" },
    publicApiOrigin: { trusted: true, value: "https://api.shorted.com.au" },
    shortsApiUrl: "https://shorts.test",
    internalSecret: "internal-secret",
    fetch: fetchImpl as unknown as typeof fetch,
    sessionCookie: async () => ({ name: "__Secure-next-auth.session-token", value: COOKIE_VALUE }),
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

function callsTo(fetchImpl: ReturnType<typeof fakeFetch>, suffix: string) {
  return fetchImpl.mock.calls.filter(([url]) => String(url).endsWith(suffix));
}

beforeEach(() => {
  // Call records from earlier tests must not count toward this test's assertions.
  jest.clearAllMocks();
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
    expect(byName(run, "chat").detail).toBe("via shorted.com.au: tools=query_short_positions; conversation deleted");
    expect(byName(run, "api_token").detail).toBe("GetStock 200 via the public API, monthly limit 50000");
    expect(byName(run, "gates").detail).toContain("both 401");
  });

  it("keeps running the later steps after the entitlement step fails", async () => {
    jest.mocked(getMySubscription).mockResolvedValue({
      ...PAID,
      status: "inactive",
      tier: "free",
      hasActiveSubscription: false,
      isPremium: false,
    });

    const run = await runPaidProbe(context(fakeFetch()));

    expect(run.ok).toBe(false);
    expect(byName(run, "entitlement").detail).toBe("no paid chat entitlement (status=inactive, tier=free)");
    expect(byName(run, "chat").ok).toBe(true);
    expect(byName(run, "api_token").ok).toBe(true);
    expect(byName(run, "gates").ok).toBe(true);
  });
});

describe("scrubbing", () => {
  it("scrubs a configured secret from a deliberate failure message", async () => {
    jest.mocked(getMySubscription).mockRejectedValue(new ProbeFailure("upstream said internal-secret is wrong"));

    const run = await runPaidProbe(context(fakeFetch()));

    expect(byName(run, "entitlement").detail).toBe("upstream said [redacted] is wrong");
  });

  it("never shows an unexpected error's message, which can carry a secret", async () => {
    jest.mocked(getMySubscription).mockRejectedValue(new Error("upstream said internal-secret is wrong"));

    const run = await runPaidProbe(context(fakeFetch()));

    expect(byName(run, "entitlement").detail).toBe("Error");
    expect(JSON.stringify(run)).not.toContain("internal-secret");
  });

  it("describes a Connect-style error by its name and numeric code", async () => {
    jest.mocked(getMySubscription).mockRejectedValue(Object.assign(new Error("[unavailable] down"), { name: "ConnectError", code: 14 }));

    const run = await runPaidProbe(context(fakeFetch()));

    expect(byName(run, "entitlement").detail).toBe("ConnectError code=14");
  });

  it("keeps the minted API token out of an unexpected error from the public read", async () => {
    const fetchImpl = fakeFetch({
      getStock: () => {
        throw new TypeError(`request failed for ${TOKEN}`);
      },
    });

    const run = await runPaidProbe(context(fetchImpl));

    expect(byName(run, "api_token").detail).toBe("TypeError");
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });

  it("scrubs the minted API token from a deliberate failure, because it was registered for this run", async () => {
    const fetchImpl = fakeFetch({
      getStock: () => {
        throw new ProbeFailure(`public API rejected ${TOKEN}`);
      },
    });

    const run = await runPaidProbe(context(fetchImpl));

    expect(byName(run, "api_token").detail).toBe("public API rejected [redacted]");
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });

  it("keeps the session cookie value out of a stream error's text", async () => {
    const withCookieInError = [
      'data: {"type":"error","errorText":"boom jwe-value"}',
      "data: [DONE]",
      "",
    ].join("\n\n");

    const run = await runPaidProbe(
      context(fakeFetch({ chat: () => sseResponse(withCookieInError) })),
    );

    expect(byName(run, "chat").detail).toBe("via shorted.com.au: stream error: boom [redacted]");
    expect(JSON.stringify(run)).not.toContain(COOKIE_VALUE);
  });

  it("never lets the minted token appear in any detail of a healthy run", async () => {
    const run = await runPaidProbe(context(fakeFetch()));
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });
});

describe("chat step", () => {
  it("fails on the 2026-10-23 tool 403 even though the HTTP status is 200", async () => {
    const fetchImpl = fakeFetch({ chat: () => sseResponse(fixture("chat-stream-tool-403.sse")) });

    const step = byName(await runPaidProbe(context(fetchImpl)), "chat");

    expect(step.ok).toBe(false);
    expect(step.detail).toContain("tool failed: get_stock_details: RPC GetStockDetails returned 403");
  });

  it("still deletes the conversation after judging a failure", async () => {
    const fetchImpl = fakeFetch({ chat: () => sseResponse(fixture("chat-stream-tool-403.sse")) });

    await runPaidProbe(context(fetchImpl));

    const deletes = callsTo(fetchImpl, "DeleteConversation");
    expect(deletes).toHaveLength(1);
    expect(JSON.parse(String((deletes[0]![1] as RequestInit).body))).toEqual({ conversationId: "conv-probe-403" });
  });

  it("fails on the error chunk and quotes its text", async () => {
    const step = byName(
      await runPaidProbe(context(fakeFetch({ chat: () => sseResponse(fixture("chat-stream-error.sse")) }))),
      "chat",
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("via shorted.com.au: stream error: Chat is temporarily unavailable.");
  });

  it("fails on a non-200, quoting only the JSON error message", async () => {
    const step = byName(
      await runPaidProbe(context(fakeFetch({ chat: () => json(403, { error: "Premium subscription required" }) }))),
      "chat",
    );
    expect(step.detail).toBe("via shorted.com.au: HTTP 403: Premium subscription required");
  });

  it("never echoes an HTML error page", async () => {
    const html = "<html><body>Cloudflare says no</body></html>";
    const step = byName(
      await runPaidProbe(context(fakeFetch({ chat: () => new Response(html, { status: 502 }) }))),
      "chat",
    );
    expect(step.detail).toBe("via shorted.com.au: HTTP 502");
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

    const step = byName(await runPaidProbe(context(fakeFetch({ chat: () => sseResponse(noTools) }))), "chat");
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("via shorted.com.au: no tool calls");
  });

  it("treats a failed conversation delete as a warning, not a failure", async () => {
    const step = byName(
      await runPaidProbe(context(fakeFetch({ deleteConversation: () => json(500, {}) }))),
      "chat",
    );
    expect(step.ok).toBe(true);
    expect(step.detail).toBe("via shorted.com.au: tools=query_short_positions; cleanup warning: HTTP 500");
  });

  it("reports a conversation the delete removed as deleted", async () => {
    const step = byName(await runPaidProbe(context(fakeFetch())), "chat");
    expect(step.detail).toBe("via shorted.com.au: tools=query_short_positions; conversation deleted");
  });

  it("reports a delete as done, and names an answer body that cannot be decoded", async () => {
    // The 2xx is the delete, so the step passes. Undici resolves fetch for a body it
    // cannot decode and fails on the read, so that failure is named here; a proxy that
    // copies a Content-Encoding onto a decoded body shows up in this detail.
    const cause = Object.assign(new Error(`incorrect header check at https://shorted.com.au/?t=${COOKIE_VALUE}`), {
      code: "Z_DATA_ERROR",
    });
    const unreadable = {
      ok: true,
      status: 200,
      text: () => Promise.reject(Object.assign(new TypeError("terminated"), { cause })),
    } as unknown as Response;
    const step = byName(await runPaidProbe(context(fakeFetch({ deleteConversation: () => unreadable }))), "chat");
    expect(step.ok).toBe(true);
    expect(step.detail).toBe(
      "via shorted.com.au: tools=query_short_positions; conversation deleted; answer unreadable: TypeError (Z_DATA_ERROR)",
    );
    expect(step.detail).not.toContain(COOKIE_VALUE);
  });

  it("names the status and the reason a refused delete gives", async () => {
    const refused = json(404, {
      error: "Conversation not found",
      code: "invalid_request",
      message: "This conversation is no longer available. Start a new chat.",
    });
    const step = byName(await runPaidProbe(context(fakeFetch({ deleteConversation: () => refused }))), "chat");
    expect(step.detail).toBe(
      "via shorted.com.au: tools=query_short_positions; cleanup warning: HTTP 404: Conversation not found",
    );
  });

  it("names the error and the code of its cause when the delete throws, never a message", async () => {
    // Fetch rejects with a cause that carries a connect code, such as a refused socket.
    const cause = Object.assign(new Error(`connect failed at https://shorted.com.au/?t=${COOKIE_VALUE}`), {
      code: "ECONNREFUSED",
    });
    const broken = Object.assign(new TypeError(`fetch failed ${COOKIE_VALUE}`), { cause });
    const step = byName(
      await runPaidProbe(
        context(
          fakeFetch({
            deleteConversation: () => {
              throw broken;
            },
          }),
        ),
      ),
      "chat",
    );
    expect(step.ok).toBe(true);
    expect(step.detail).toBe(
      "via shorted.com.au: tools=query_short_positions; cleanup warning: TypeError (ECONNREFUSED)",
    );
    expect(step.detail).not.toContain(COOKIE_VALUE);
  });

  it("names only the error when its cause carries no code", async () => {
    const step = byName(
      await runPaidProbe(
        context(
          fakeFetch({
            deleteConversation: () => {
              throw new TypeError("fetch failed");
            },
          }),
        ),
      ),
      "chat",
    );
    expect(step.detail).toBe("via shorted.com.au: tools=query_short_positions; cleanup warning: TypeError");
  });

  it("sends the probe cookie, the app origin and the fixed question", async () => {
    const fetchImpl = fakeFetch();
    await runPaidProbe(context(fetchImpl));

    const chatCall = fetchImpl.mock.calls.find(([url]) => String(url) === "https://shorted.com.au/api/chat");
    const init = chatCall![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe(`__Secure-next-auth.session-token=${COOKIE_VALUE}`);
    expect(headers.origin).toBe("https://shorted.com.au");
    expect(init.redirect).toBe("manual");
    const body = JSON.parse(String(init.body)) as { messages: ShortedChatUIMessage[] };
    expect(extractLatestUserText(body.messages)).toBe(PAID_PROBE_QUESTION);
  });

  it("fails when NEXTAUTH_SECRET is not configured, before any cookied request", async () => {
    const fetchImpl = fakeFetch();
    const run = await runPaidProbe(
      context(fetchImpl, {
        sessionCookie: async () => {
          throw new ProbeFailure("NEXTAUTH_SECRET is not configured");
        },
      }),
    );
    expect(byName(run, "chat").detail).toBe("via shorted.com.au: NEXTAUTH_SECRET is not configured");
    expect(callsTo(fetchImpl, "/api/chat").filter(([, init]) => (init?.headers as Record<string, string>).cookie !== undefined)).toHaveLength(0);
  });

  it("deletes the conversation of a turn that timed out after streaming its id", async () => {
    const fetchImpl = fakeFetch({
      chat: () => new Response(cutOffStream(fixture("chat-stream-conversation-timeout.sse")), { status: 200 }),
    });

    const step = byName(await runPaidProbe(context(fetchImpl)), "chat");

    expect(step.ok).toBe(false);
    expect(step.detail).toBe("via shorted.com.au: timed out after 35s");
    const deletes = callsTo(fetchImpl, "DeleteConversation");
    expect(deletes).toHaveLength(1);
    expect(JSON.parse(String((deletes[0]![1] as RequestInit).body))).toEqual({ conversationId: "conv-probe-part" });
  });

  it("reports a timeout before any stream arrives as the turn's limit, with nothing to delete", async () => {
    const fetchImpl = fakeFetch({
      chat: () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });

    const step = byName(await runPaidProbe(context(fetchImpl)), "chat");

    expect(step.ok).toBe(false);
    expect(step.detail).toBe("via shorted.com.au: timed out after 35s");
    expect(callsTo(fetchImpl, "DeleteConversation")).toHaveLength(0);
  });

  it("deletes the conversation of a turn that ended in an error chunk after its id was streamed", async () => {
    const partThenError = [
      'data: {"type":"text-start","id":"a"}',
      'data: {"type":"data-shorted-conversation","id":"shorted-conversation","data":{"conversationId":"conv-error-part"}}',
      'data: {"type":"error","errorText":"Chat is temporarily unavailable."}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const fetchImpl = fakeFetch({ chat: () => sseResponse(partThenError) });

    const step = byName(await runPaidProbe(context(fetchImpl)), "chat");

    expect(step.detail).toBe("via shorted.com.au: stream error: Chat is temporarily unavailable.");
    const deletes = callsTo(fetchImpl, "DeleteConversation");
    expect(JSON.parse(String((deletes[0]![1] as RequestInit).body))).toEqual({ conversationId: "conv-error-part" });
  });

  it("sends nothing to an untrusted origin: no cookie, no chat request, no delete", async () => {
    const fetchImpl = fakeFetch();
    const sessionCookie = jest.fn(async () => ({ name: "n", value: COOKIE_VALUE }));

    const run = await runPaidProbe(
      context(fetchImpl, {
        origin: { trusted: false, reason: "untrusted base URL" },
        sessionCookie,
      }),
    );

    expect(byName(run, "chat").detail).toBe("untrusted base URL");
    expect(sessionCookie).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).startsWith("https://shorted.com.au"))).toBe(false);
  });
});

describe("api_token step", () => {
  it("fails a token on the free tier", async () => {
    const step = byName(
      await runPaidProbe(
        context(fakeFetch({ getStock: () => json(200, { productCode: "BHP" }, { "x-ratelimit-monthly-limit": "1000", "x-shorted-cache": "BYPASS" }) })),
      ),
      "api_token",
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("token is not on a paid API tier (monthly limit 1000)");
  });

  it("fails when the monthly header is absent, as when rate limiting is off", async () => {
    const step = byName(
      await runPaidProbe(context(fakeFetch({ getStock: () => json(200, { productCode: "BHP" }, { "x-shorted-cache": "BYPASS" }) }))),
      "api_token",
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("token is not on a paid API tier (monthly limit absent)");
  });

  it("passes at the paid floor, sending the token as a Bearer credential to the public host", async () => {
    const fetchImpl = fakeFetch({
      getStock: () =>
        json(200, { productCode: "BHP" }, {
          "x-ratelimit-monthly-limit": String(PAID_API_MONTHLY_LIMIT_MIN),
          "x-shorted-cache": "BYPASS",
        }),
    });
    const step = byName(await runPaidProbe(context(fetchImpl)), "api_token");

    expect(step.ok).toBe(true);
    const stockCall = fetchImpl.mock.calls.find(([url]) => String(url) === PUBLIC_GET_STOCK);
    expect(stockCall).toBeDefined();
    expect((stockCall![1] as RequestInit).headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it("sends the authenticated read with no bypass header, and mints the token on the server API", async () => {
    const fetchImpl = fakeFetch();
    await runPaidProbe(context(fetchImpl));

    const stockCall = fetchImpl.mock.calls.find(([url]) => String(url) === PUBLIC_GET_STOCK);
    const headers = (stockCall![1] as RequestInit).headers as Record<string, string>;
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toEqual(
      expect.arrayContaining(["x-shorted-ssr-bypass", "x-shorted-testing-bypass"]),
    );
    expect(headers["connect-protocol-version"]).toBe("1");
    // The mint is internal: it is handed the server API URL, not the public host.
    const mintContext = jest.mocked(mintApiToken).mock.calls[0]![0];
    expect(mintContext.shortsApiUrl).toBe("https://shorts.test");
  });

  it("fails when the answer did not pass through the edge, or came from its cache", async () => {
    for (const [header, want] of [
      ["HIT", "x-shorted-cache: HIT"],
      ["MISS", "x-shorted-cache: MISS"],
      [undefined, "x-shorted-cache: absent"],
    ] as const) {
      const extra: Record<string, string> = header === undefined ? {} : { "x-shorted-cache": header };
      const step = byName(
        await runPaidProbe(
          context(
            fakeFetch({ getStock: () => json(200, { productCode: "BHP" }, { "x-ratelimit-monthly-limit": "50000", ...extra }) }),
          ),
        ),
        "api_token",
      );
      expect(step.ok).toBe(false);
      expect(step.detail).toBe(`answer was not passed through to origin (${want})`);
    }
  });

  it("refuses an untrusted public host before minting anything", async () => {
    const fetchImpl = fakeFetch();

    const step = byName(
      await runPaidProbe(
        context(fetchImpl, { publicApiOrigin: { trusted: false, reason: "untrusted public API URL" } }),
      ),
      "api_token",
    );

    expect(step.detail).toBe("untrusted public API URL");
    expect(mintApiToken).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/GetStock"))).toBe(false);
  });

  it("fails when the answer is not a JSON object", async () => {
    const step = byName(
      await runPaidProbe(
        context(
          fakeFetch({
            getStock: () =>
              new Response("<html>", {
                status: 200,
                headers: { "x-ratelimit-monthly-limit": "50000", "x-shorted-cache": "BYPASS" },
              }),
          }),
        ),
      ),
      "api_token",
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("GetStock with the token returned no JSON object");
  });
});

describe("gates step", () => {
  it("fails when /api/chat answers a redirect instead of a 401", async () => {
    const step = byName(
      await runPaidProbe(
        context(fakeFetch({ gateChat: () => new Response(null, { status: 307, headers: { location: "/signin" } }) })),
      ),
      "gates",
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("via shorted.com.au: /api/chat answered 307, want 401");
  });

  it("fails when the checkout route answers 200 to an anonymous caller", async () => {
    const step = byName(
      await runPaidProbe(context(fakeFetch({ checkout: () => json(200, { url: "https://checkout.stripe.com/x" }) }))),
      "gates",
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toBe("via shorted.com.au: /api/stripe/checkout answered 200, want 401");
  });

  it("sends the anonymous gate a real user message and no cookie", async () => {
    const fetchImpl = fakeFetch();
    await runPaidProbe(context(fetchImpl));

    const gateCall = fetchImpl.mock.calls.find(
      ([url, init]) =>
        String(url) === "https://shorted.com.au/api/chat" &&
        (init?.headers as Record<string, string> | undefined)?.cookie === undefined,
    );
    const init = gateCall![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { messages: ShortedChatUIMessage[] };
    expect(extractLatestUserText(body.messages)).toBe(PAID_PROBE_QUESTION);
  });

  it("sends nothing to an untrusted origin", async () => {
    const fetchImpl = fakeFetch();

    const step = byName(
      await runPaidProbe(context(fetchImpl, { origin: { trusted: false, reason: "untrusted base URL" } })),
      "gates",
    );

    expect(step.detail).toBe("untrusted base URL");
    expect(fetchImpl.mock.calls.some(([url]) => String(url).startsWith("https://shorted.com.au"))).toBe(false);
  });
});

describe("the origin the app steps called", () => {
  const DEPLOYMENT = "https://shorted-com-abc.vercel.app";

  it("labels a step's detail 'via deployment' with the host, when the deployment is what was probed", async () => {
    const run = await runPaidProbe(
      context(fakeFetch(), { origin: { trusted: true, value: DEPLOYMENT }, deploymentOrigin: DEPLOYMENT }),
    );

    expect(byName(run, "chat").detail).toBe(
      "via deployment shorted-com-abc.vercel.app: tools=query_short_positions; conversation deleted",
    );
    expect(byName(run, "gates").detail).toBe(
      "via deployment shorted-com-abc.vercel.app: anonymous /api/chat and /api/stripe/checkout both 401",
    );
    // The public API step does not touch the app, so it is not labelled.
    expect(byName(run, "api_token").detail).toBe("GetStock 200 via the public API, monthly limit 50000");
  });

  it("labels the apex when the probe went to shorted.com.au, even with a deployment known", async () => {
    const run = await runPaidProbe(context(fakeFetch(), { deploymentOrigin: DEPLOYMENT }));

    expect(byName(run, "gates").detail.startsWith("via shorted.com.au: ")).toBe(true);
  });

  it("fails a deployment answer with the deployment named, so the edge is shown to be out of the path", async () => {
    const run = await runPaidProbe(
      context(fakeFetch({ chat: () => json(403, { error: "Premium subscription required" }) }), {
        origin: { trusted: true, value: DEPLOYMENT },
        deploymentOrigin: DEPLOYMENT,
      }),
    );

    expect(byName(run, "chat").detail).toBe(
      "via deployment shorted-com-abc.vercel.app: HTTP 403: Premium subscription required",
    );
  });

  it("sends every app call with the Origin it called, so the same-origin check sees its own origin", async () => {
    const fetchImpl = fakeFetch();
    await runPaidProbe(context(fetchImpl, { origin: { trusted: true, value: DEPLOYMENT }, deploymentOrigin: DEPLOYMENT }));

    // The chat turn, the anonymous chat gate, the anonymous checkout gate and the conversation delete.
    const appCalls = fetchImpl.mock.calls.filter(([url]) => String(url).startsWith(`${DEPLOYMENT}/`));
    expect(appCalls).toHaveLength(4);
    for (const [url, init] of appCalls) {
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.origin).toBe(DEPLOYMENT);
      expect(String(url).startsWith(headers.origin!)).toBe(true);
    }
  });

  it("scrubs the bypass secret when an app error echoes it", async () => {
    const fetchImpl = fakeFetch({ chat: () => json(500, { error: "upstream echoed bypass-value" }) });

    const step = byName(
      await runPaidProbe(context(fetchImpl, { secrets: ["internal-secret", "bypass-value"] })),
      "chat",
    );

    expect(step.detail).toBe("via shorted.com.au: HTTP 500: upstream echoed [redacted]");
    expect(JSON.stringify(step)).not.toContain("bypass-value");
  });
});

describe("chatRequestBody", () => {
  it("is the shape the app's own reader expects", () => {
    expect(extractLatestUserText(chatRequestBody().messages as ShortedChatUIMessage[])).toBe(PAID_PROBE_QUESTION);
  });
});

describe("time budget", () => {
  it("the worst case, every step at its budget and then the check-ins, stays under the admin tool's 75s ceiling", () => {
    expect(PROBE_WORST_CASE_CEILING_MS).toBe(75_000);
    expect(probeWorstCaseMs()).toBeLessThanOrEqual(PROBE_WORST_CASE_CEILING_MS);
  });

  it("is the documented 72s: 8 + 40 + 10 + 8 for the steps, then 6 for the check-ins", () => {
    expect(PROBE_STEP_BUDGETS).toEqual({ entitlement: 8_000, chat: 40_000, api_token: 10_000, gates: 8_000 });
    expect(CHECKIN_BUDGET_MS).toBe(6_000);
    expect(probeWorstCaseMs()).toBe(72_000);
  });

  it("counts every step, so the total cannot quietly leave one out", () => {
    expect(Object.keys(PROBE_STEP_BUDGETS).sort()).toEqual([...PROBE_STEP_NAMES].sort());
  });

  it("gives the chat turn and its cleanup together exactly the chat step's budget", () => {
    expect(CHAT_TURN_BUDGET_MS + STEP_BUDGET_MS.chatCleanup).toBe(STEP_BUDGET_MS.chat);
  });
});

describe("stream helpers", () => {
  it("streamOf delivers its chunks in order", async () => {
    const reader = streamOf("a", "b").getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("a");
  });
});
