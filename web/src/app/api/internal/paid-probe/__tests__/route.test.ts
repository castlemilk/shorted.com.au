/** @jest-environment node */
import type { NextRequest } from "next/server";

import { POST, maxDuration } from "../route";
import { reportCheckins } from "~/server/paid-probe/checkins";
import { runPaidProbe, type PaidProbeRun } from "~/server/paid-probe/steps";

// The route wires the real context and guard; only the run and the check-ins are stubbed.
jest.mock("next-auth/jwt", () => ({ encode: jest.fn(async () => "jwe-value"), decode: jest.fn() }));
jest.mock("~/app/actions/config", () => ({ getServerShortsApiUrl: () => "https://shorts.test" }));
jest.mock("~/server/paid-probe/steps", () => ({ runPaidProbe: jest.fn() }));
jest.mock("~/server/paid-probe/checkins", () => ({ reportCheckins: jest.fn(async () => "disabled") }));

const ENV_KEYS = ["INTERNAL_SERVICE_SECRET", "PAID_PROBE_TOKEN", "PAID_PROBE_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};
const CALLED_ON = "https://shorted.com.au/api/internal/paid-probe";

function run(ok: boolean): PaidProbeRun {
  return {
    ok,
    startedAt: "2026-10-23T02:00:00.000Z",
    durationMs: 1234,
    steps: [
      { name: "entitlement", ok: true, durationMs: 1, detail: "status=active tier=enterprise" },
      {
        name: "chat",
        ok,
        durationMs: 2,
        detail: ok ? "tools=query_short_positions; conversation deleted" : "tool failed: get_stock_details: RPC GetStockDetails returned 403",
      },
      { name: "api_token", ok: true, durationMs: 3, detail: "GetStock 200, monthly limit 50000" },
      { name: "gates", ok: true, durationMs: 4, detail: "anonymous /api/chat and /api/stripe/checkout both 401" },
    ],
  };
}

// The jest setup replaces Request with a stub whose headers are a Map, so a real
// NextRequest cannot carry headers here. Only .url and .headers are read.
function request(headers: Record<string, string> = {}, url = CALLED_ON): NextRequest {
  return { url, method: "POST", headers: new Headers(headers) } as unknown as NextRequest;
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INTERNAL_SERVICE_SECRET = "internal-secret";
  process.env.PAID_PROBE_TOKEN = "probe-token";
  delete process.env.PAID_PROBE_BASE_URL;
  jest.mocked(runPaidProbe).mockResolvedValue(run(true));
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("POST /api/internal/paid-probe", () => {
  it("exports the 120s budget the vercel.json entry also sets", () => {
    expect(maxDuration).toBe(120);
  });

  it("refuses a caller with no credential, without running anything", async () => {
    const res = await POST(request());
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(runPaidProbe).not.toHaveBeenCalled();
  });

  it("refuses a wrong Bearer token", async () => {
    const res = await POST(request({ authorization: "Bearer guess" }));
    expect(res.status).toBe(401);
    expect(runPaidProbe).not.toHaveBeenCalled();
  });

  it("refuses everything when PAID_PROBE_TOKEN is unset and no internal secret is sent", async () => {
    delete process.env.PAID_PROBE_TOKEN;
    const res = await POST(request({ authorization: "Bearer " }));
    expect(res.status).toBe(401);
  });

  it("runs for the correct Bearer token and answers 200 when every step passes", async () => {
    const res = await POST(request({ authorization: "Bearer probe-token" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, startedAt: "2026-10-23T02:00:00.000Z", durationMs: 1234, checkins: "disabled" });
    expect(body.steps).toHaveLength(4);
  });

  it("runs for the internal service secret", async () => {
    const res = await POST(request({ "x-internal-secret": "internal-secret" }));
    expect(res.status).toBe(200);
    expect(runPaidProbe).toHaveBeenCalledTimes(1);
  });

  it("answers 503 with the failing step in the body when a step fails", async () => {
    jest.mocked(runPaidProbe).mockResolvedValue(run(false));

    const res = await POST(request({ authorization: "Bearer probe-token" }));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; steps: Array<{ name: string; ok: boolean; detail: string }> };
    expect(body.ok).toBe(false);
    const chat = body.steps.find((step) => step.name === "chat");
    expect(chat).toMatchObject({ ok: false });
    expect(chat?.detail).toContain("RPC GetStockDetails returned 403");
  });

  it("refuses a second run on the same instance with 409 while the first is in flight", async () => {
    let finish: (value: PaidProbeRun) => void = () => undefined;
    jest.mocked(runPaidProbe).mockImplementation(
      () => new Promise<PaidProbeRun>((resolve) => { finish = resolve; }),
    );

    const first = POST(request({ authorization: "Bearer probe-token" }));
    const second = await POST(request({ authorization: "Bearer probe-token" }));

    expect(second.status).toBe(409);
    expect(runPaidProbe).toHaveBeenCalledTimes(1);

    finish(run(true));
    expect((await first).status).toBe(200);
  });

  it("probes the configured base URL's origin, and the Go API it is given", async () => {
    process.env.PAID_PROBE_BASE_URL = "https://preview.example.test/";
    await POST(request({ authorization: "Bearer probe-token" }));

    const ctx = jest.mocked(runPaidProbe).mock.calls[0]![0];
    expect(ctx.origin).toBe("https://preview.example.test");
    expect(ctx.shortsApiUrl).toBe("https://shorts.test");
  });

  it("passes the check-in outcome through", async () => {
    jest.mocked(reportCheckins).mockResolvedValueOnce("partial");
    const body = (await (await POST(request({ authorization: "Bearer probe-token" }))).json()) as { checkins: string };
    expect(body.checkins).toBe("partial");
  });
});
