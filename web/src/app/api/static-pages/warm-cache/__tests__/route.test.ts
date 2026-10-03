/** @jest-environment node */
import type { NextRequest } from "next/server";
import { GET } from "../route";

const invalidate = jest.fn();
jest.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => invalidate(...args) }));
jest.mock("~/config/isr-shell-pages.json", () => ["/market", "/price-drops"]);

function request(query = "", headers = new Headers()): NextRequest {
  return { nextUrl: new URL(`http://localhost/api/static-pages/warm-cache${query}`), headers } as NextRequest;
}
function html(body = "<main>Ready</main>", status = 200) {
  return { ok: status === 200, status, text: async () => body };
}

describe("static page warming", () => {
  const previous = { ...process.env };
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CACHE_WARM_SECRET;
    delete process.env.CRON_SECRET;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    fetchMock = jest.fn().mockResolvedValue(html());
    global.fetch = fetchMock;
  });
  afterAll(() => { global.fetch = originalFetch; process.env = previous; });

  it("checks healthy pages without invalidating or regenerating them", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(invalidate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await response.json()).results["/market"].action).toBe("checked");
  });

  it("queues only a confirmed shell for repair after the response", async () => {
    const reads: Record<string, number> = {};
    fetchMock.mockImplementation(async (url: string) => {
      reads[url] = (reads[url] ?? 0) + 1;
      return html(url.endsWith("/market") && reads[url] === 1
        ? '<span hidden data-isr-shell="empty"></span>' : "Ready");
    });
    const response = await GET(request());
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.pending).toBe(true);
    expect(body.results["/market"].action).toBe("repair-pending");
    expect(invalidate.mock.calls).toEqual([["/market"]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await GET(request())).status).toBe(200);
  });

  it("invalidates build shells in a separate request before priming", async () => {
    const response = await GET(request("?mode=deploy"));
    expect(response.status).toBe(200);
    expect(invalidate.mock.calls).toEqual([["/market"], ["/price-drops"]]);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.invalidated).toBe(true);
    expect(body.success).toBe(false);
  });

  it("reports unresolved shells and HTTP failures honestly", async () => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith("/market")
      ? html('<span hidden data-isr-shell="empty"></span>') : html("Unavailable", 503));
    const response = await GET(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.results["/market"].action).toBe("repair-pending");
    expect(body.pending).toBe(true);
    expect(body.results["/price-drops"].error).toBe("HTTP 503");
    expect(invalidate.mock.calls).toEqual([["/market"]]);
  });

  it("does not repair legitimate dated or withheld empty answers", async () => {
    fetchMock.mockResolvedValue(html('<div data-empty-state="dated">No recent listings</div>'));
    expect((await GET(request())).status).toBe(200);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("waits for a slow cold price-drop body without invalidating healthy data", async () => {
    jest.useFakeTimers();
    const timeout = jest.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("Page read timed out")), ms);
      return controller.signal;
    });
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => ({
      ok: true,
      status: 200,
      text: () => url.endsWith("/price-drops")
        ? new Promise<string>((resolve, reject) => {
          const completed = setTimeout(() => resolve("<main>Price drops ready</main>"), 35_000);
          options.signal?.addEventListener("abort", () => {
            clearTimeout(completed);
            reject(options.signal?.reason);
          }, { once: true });
        })
        : Promise.resolve("<main>Market ready</main>"),
    }));
    try {
      const pending = GET(request());
      await jest.advanceTimersByTimeAsync(35_000);
      const response = await pending;
      expect(response.status).toBe(200);
      expect((await response.json()).results["/price-drops"].success).toBe(true);
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("supports the warm header and authenticated Vercel cron, rejecting bad credentials", async () => {
    process.env.CACHE_WARM_SECRET = "warm-test";
    process.env.CRON_SECRET = "cron-test";
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request("", new Headers({ "X-Cache-Warm-Secret": "warm-test" })))).status).toBe(200);
    expect((await GET(request("", new Headers({ Authorization: "Bearer cron-test" })))).status).toBe(200);
  });

  it("uses the internal deployment origin with bounded requests", async () => {
    process.env.VERCEL_URL = "preview.vercel.app";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "existing-test-bypass";
    await GET(request());
    expect(fetchMock).toHaveBeenCalledWith("https://preview.vercel.app/market", expect.objectContaining({
      redirect: "error", signal: expect.anything(),
      headers: expect.objectContaining({ "x-vercel-protection-bypass": "existing-test-bypass" }),
    }));
  });
});
