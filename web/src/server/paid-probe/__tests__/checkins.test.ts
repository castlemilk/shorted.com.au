/** @jest-environment node */
import {
  isTelesisCheckinURL,
  parseCheckinConfig,
  reportCheckins,
  sendCheckins,
  type CheckinUrls,
} from "../checkins";
import type { PaidProbeRun } from "../steps";

const TOKEN = "tok-SECRET-0123456789abcdef";
const URL_BASE = `https://api.telesis.dev/v1/cron/${TOKEN}`;

const RUN_OK: PaidProbeRun = {
  ok: true,
  startedAt: "2026-10-23T02:00:00.000Z",
  durationMs: 9_000,
  steps: [
    { name: "entitlement", ok: true, durationMs: 1, detail: "status=active tier=enterprise" },
    { name: "chat", ok: true, durationMs: 2, detail: "tools=query_short_positions" },
    { name: "api_token", ok: true, durationMs: 3, detail: "GetStock 200, monthly limit 50000" },
    { name: "gates", ok: true, durationMs: 4, detail: "both 401" },
  ],
};

const RUN_CHAT_FAILED: PaidProbeRun = {
  ...RUN_OK,
  ok: false,
  steps: [
    RUN_OK.steps[0]!,
    { name: "chat", ok: false, durationMs: 2, detail: "tool failed: get_stock_details: RPC GetStockDetails returned 403" },
    RUN_OK.steps[2]!,
    RUN_OK.steps[3]!,
  ],
};

function okFetch(status = 200) {
  // Typed with parameters so its recorded calls are indexable, as the assertions below need.
  return jest.fn(async (_url?: unknown, _init?: unknown) => new Response("{}", { status }));
}

function bodyOf(call: unknown[]): unknown {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe("parseCheckinConfig", () => {
  it("is undefined when the variable is absent or blank", () => {
    expect(parseCheckinConfig(undefined)).toBeUndefined();
    expect(parseCheckinConfig("   ")).toBeUndefined();
  });

  it("accepts a map of step names to private Telesis URLs", () => {
    expect(parseCheckinConfig(JSON.stringify({ chat: URL_BASE, all: URL_BASE }))).toEqual({
      chat: URL_BASE,
      all: URL_BASE,
    });
  });

  it("disables everything on one unknown key, so a typo cannot drop one check-in silently", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseCheckinConfig(JSON.stringify({ chat: URL_BASE, chta: URL_BASE }))).toBeUndefined();
    warn.mockRestore();
  });

  it("disables everything on invalid JSON, a non-object, or an empty map", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseCheckinConfig("{not json")).toBeUndefined();
    expect(parseCheckinConfig("[]")).toBeUndefined();
    expect(parseCheckinConfig("{}")).toBeUndefined();
    warn.mockRestore();
  });

  it("never logs the configured value when it rejects it, and warns once", () => {
    // A fresh module, so the once-per-process warning is not already spent by an earlier test.
    jest.isolateModules(() => {
      const fresh = require("../checkins") as typeof import("../checkins");
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const bad = JSON.stringify({ chat: `https://evil.example/${TOKEN}` });
      fresh.parseCheckinConfig(bad);
      fresh.parseCheckinConfig(bad);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain("evil.example");
      warn.mockRestore();
    });
  });
});

describe("isTelesisCheckinURL", () => {
  it("accepts an https cron URL on the Telesis host", () => {
    expect(isTelesisCheckinURL(URL_BASE)).toBe(true);
  });

  it("rejects other hosts, schemes, paths, credentials and query strings", () => {
    for (const value of [
      `http://api.telesis.dev/v1/cron/${TOKEN}`,
      `https://api.telesis.dev.evil.example/v1/cron/${TOKEN}`,
      `https://user:pw@api.telesis.dev/v1/cron/${TOKEN}`,
      `https://api.telesis.dev/v1/cron/`,
      `https://api.telesis.dev/v2/cron/${TOKEN}`,
      `https://api.telesis.dev/v1/cron/${TOKEN}?x=1`,
      "not a url",
    ]) {
      expect(isTelesisCheckinURL(value)).toBe(false);
    }
  });
});

describe("sendCheckins", () => {
  it("posts complete for passing steps and fail for failing ones, with the duration and reason", async () => {
    const fetchImpl = okFetch();
    const urls: CheckinUrls = { chat: URL_BASE, api_token: URL_BASE };

    const status = await sendCheckins(urls, RUN_CHAT_FAILED, fetchImpl as unknown as typeof fetch);

    expect(status).toBe("sent");
    const calls = fetchImpl.mock.calls;
    const endpoints = calls.map((call) => String(call[0])).sort();
    expect(endpoints).toEqual([`${URL_BASE}/fail`, `${URL_BASE}/complete`].sort());

    const failCall = calls.find((call) => String(call[0]).endsWith("/fail"));
    expect(failCall).toBeDefined();
    expect(bodyOf(failCall!)).toEqual({
      duration_ms: 2,
      terminal_reason: "tool failed: get_stock_details: RPC GetStockDetails returned 403",
    });
    const completeCall = calls.find((call) => String(call[0]).endsWith("/complete"));
    expect(bodyOf(completeCall!)).toMatchObject({ duration_ms: 3 });
  });

  it("sends the overall result on the all key", async () => {
    const fetchImpl = okFetch();
    await sendCheckins({ all: URL_BASE }, RUN_CHAT_FAILED, fetchImpl as unknown as typeof fetch);

    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${URL_BASE}/fail`);
    expect(bodyOf(fetchImpl.mock.calls[0]!)).toMatchObject({ terminal_reason: "failed: chat" });
  });

  it("reports all steps passed on a healthy run", async () => {
    const fetchImpl = okFetch();
    await sendCheckins({ all: URL_BASE }, RUN_OK, fetchImpl as unknown as typeof fetch);

    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${URL_BASE}/complete`);
    expect(bodyOf(fetchImpl.mock.calls[0]!)).toMatchObject({ terminal_reason: "4/4 steps passed" });
  });

  it("swallows a failed check-in, reports partial, and never logs the URL", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    // A fetch TypeError can carry the URL in its message. It must not reach a log.
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.endsWith("/complete")) throw new TypeError(`Failed to fetch ${url}`);
      return new Response("", { status: 204 });
    });

    const status = await sendCheckins({ entitlement: URL_BASE, all: URL_BASE }, RUN_OK, fetchImpl as unknown as typeof fetch);

    expect(status).toBe("partial");
    const everything = JSON.stringify([warn.mock.calls, error.mock.calls, log.mock.calls]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).toContain("check-in entitlement failed: TypeError");
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it("marks a non-2xx answer as partial", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const status = await sendCheckins({ all: URL_BASE }, RUN_OK, okFetch(401) as unknown as typeof fetch);
    expect(status).toBe("partial");
    warn.mockRestore();
  });

  it("truncates terminal_reason to 1024 bytes on a character boundary", async () => {
    const fetchImpl = okFetch();
    const long: PaidProbeRun = {
      ...RUN_OK,
      ok: false,
      steps: [{ name: "chat", ok: false, durationMs: 1, detail: "é".repeat(2000) }],
    };
    await sendCheckins({ chat: URL_BASE }, long, fetchImpl as unknown as typeof fetch);
    const reason = (bodyOf(fetchImpl.mock.calls[0]!) as { terminal_reason: string }).terminal_reason;
    expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(1024);
    expect(reason).not.toMatch(/�/);
  });
});

describe("reportCheckins", () => {
  it("reports invalid, not disabled, when the variable is set but unusable, and sends nothing", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = okFetch();
    const status = await reportCheckins(
      RUN_OK,
      { TELESIS_PAID_PROBE_CHECKINS: JSON.stringify({ chta: URL_BASE }) },
      fetchImpl as unknown as typeof fetch,
    );
    expect(status).toBe("invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports disabled for a blank variable, which is dormant rather than broken", async () => {
    const fetchImpl = okFetch();
    expect(await reportCheckins(RUN_OK, { TELESIS_PAID_PROBE_CHECKINS: "  " }, fetchImpl as unknown as typeof fetch)).toBe("disabled");
  });

  it("reports disabled and sends nothing when the variable is unset", async () => {
    const fetchImpl = okFetch();
    const status = await reportCheckins(RUN_OK, {}, fetchImpl as unknown as typeof fetch);
    expect(status).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends when the variable is a valid map", async () => {
    const fetchImpl = okFetch();
    const status = await reportCheckins(
      RUN_OK,
      { TELESIS_PAID_PROBE_CHECKINS: JSON.stringify({ gates: URL_BASE }) },
      fetchImpl as unknown as typeof fetch,
    );
    expect(status).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
