/** @jest-environment node */
import type { NextRequest } from "next/server";
import { GET, POST } from "../route";

const invalidate = jest.fn();
jest.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => invalidate(...args) }));

function request(headers = new Headers()): NextRequest {
  return { nextUrl: new URL("http://localhost/api/pages/warm-cache"), headers } as NextRequest;
}

describe("homepage page warmer", () => {
  const previous = { ...process.env };
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const name of ["CACHE_WARM_SECRET", "CRON_SECRET", "REVALIDATION_SECRET", "VERCEL", "VERCEL_ENV", "VERCEL_REGION", "VERCEL_URL", "VERCEL_AUTOMATION_BYPASS_SECRET"]) {
      delete process.env[name];
    }
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterAll(() => { global.fetch = originalFetch; process.env = previous; });

  it("invalidates only the homepage, then fetches it after the invalidation response", async () => {
    process.env.CRON_SECRET = "cron-test";
    process.env.VERCEL_URL = "preview.vercel.app";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-test";
    const events: string[] = [];
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      const headers = new Headers(options.headers);
      if (url.endsWith("/api/pages/warm-cache")) {
        events.push("invalidate request");
        expect(options.method).toBe("POST");
        expect(headers.get("authorization")).toBe("Bearer cron-test");
        expect(headers.get("x-vercel-protection-bypass")).toBe("bypass-test");
        const response = await POST(request(headers));
        return { ok: response.ok, json: async () => { events.push("invalidate response"); return response.json(); } };
      }
      events.push("homepage request");
      expect(url).toBe("https://preview.vercel.app/");
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("x-cache-warm-secret")).toBe(false);
      expect(headers.get("x-vercel-protection-bypass")).toBe("bypass-test");
      return { ok: true, text: async () => { events.push("homepage read"); return "<main>Ready</main>"; } };
    });

    const response = await GET(request(new Headers({ Authorization: "Bearer cron-test" })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, warmed: "/" });
    expect(invalidate.mock.calls).toEqual([["/", "page"]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["invalidate request", "invalidate response", "homepage request", "homepage read"]);
  });

  it("does not invalidate or fetch anything without authorization", async () => {
    process.env.CRON_SECRET = "cron-test";
    expect((await GET(request())).status).toBe(401);
    expect((await POST(request())).status).toBe(401);
    expect(invalidate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never forwards a warm credential to an untrusted request host", async () => {
    process.env.CRON_SECRET = "cron-test";
    const external = {
      nextUrl: new URL("https://untrusted.example/api/pages/warm-cache"),
      headers: new Headers({ Authorization: "Bearer cron-test" }),
    } as NextRequest;
    const response = await GET(external);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, stage: "origin" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not warm the homepage if invalidation fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ success: false, stage: "invalidate" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a failed homepage fetch instead of claiming it warmed", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ invalidated: true }) });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ success: false, stage: "warm" });
  });
});
