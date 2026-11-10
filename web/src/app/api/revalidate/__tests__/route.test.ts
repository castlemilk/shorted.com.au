import type { NextRequest } from "next/server";

import { POST } from "../route";

const revalidatePathMock = jest.fn();
const revalidateTagMock = jest.fn();
const deleteCachedByPrefixMock = jest
  .fn()
  .mockResolvedValue({ deleted: 0, errors: [], scanIterations: 0 });
const invalidateQuotesMock = jest.fn().mockResolvedValue(true);
jest.mock("~/@/lib/shared-stock-quotes", () => ({
  invalidateSharedStockQuotes: (...args: unknown[]) => invalidateQuotesMock(...args),
}));

jest.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
  revalidateTag: (...args: unknown[]) => revalidateTagMock(...args),
}));

jest.mock("~/@/lib/kv-cache", () => ({
  deleteCachedByPrefix: (...args: unknown[]) =>
    deleteCachedByPrefixMock(...args),
  HOUSING_DATA_CACHE_PREFIXES: ["cache:housing:"],
  POLITICIANS_DATA_CACHE_PREFIXES: ["cache:politicians:"],
  SHORTS_DATA_CACHE_PREFIXES: ["cache:shorts:"],
}));

describe("POST /api/revalidate", () => {
  const originalSecret = process.env.REVALIDATION_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    deleteCachedByPrefixMock.mockResolvedValue({ deleted: 0, errors: [], scanIterations: 0 });
    invalidateQuotesMock.mockResolvedValue(true);
    process.env.REVALIDATION_SECRET = "test-revalidation-secret";
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.REVALIDATION_SECRET;
    else process.env.REVALIDATION_SECRET = originalSecret;
  });

  function request(url: string, headerSecret?: string, body?: string): NextRequest {
    const parsed = new URL(url);
    return {
      nextUrl: { searchParams: parsed.searchParams },
      headers: new Headers(
        headerSecret === undefined
          ? undefined
          : { "X-Revalidate-Secret": headerSecret },
      ),
      text: () => Promise.resolve(body ?? ""),
    } as unknown as NextRequest;
  }

  it("invalidates shared quotes without scanning the Redis keyspace", async () => {
    const response = await POST(request("http://localhost/api/revalidate?flush=quotes", "test-revalidation-secret"));
    expect((await response.json()).quoteCacheInvalidated).toBe(true);
    expect(invalidateQuotesMock).toHaveBeenCalledTimes(1);
    expect(deleteCachedByPrefixMock).not.toHaveBeenCalled();
  });

  it("reports failed quote invalidation and rejects unauthorized invalidation", async () => {
    invalidateQuotesMock.mockResolvedValue(false);
    const response = await POST(request("http://localhost/api/revalidate?flush=quotes", "test-revalidation-secret"));
    expect(await response.json()).toMatchObject({ revalidated: false, flushErrors: ["quotes: cache generation update failed"] });
    invalidateQuotesMock.mockClear();
    expect((await POST(request("http://localhost/api/revalidate?flush=quotes", "wrong"))).status).toBe(401);
    expect(invalidateQuotesMock).not.toHaveBeenCalled();
  });

  it("accepts the secret from X-Revalidate-Secret", async () => {
    const req = request(
      "http://localhost/api/revalidate?path=/price-drops&flush=housing",
      "test-revalidation-secret",
    );

    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(revalidatePathMock).toHaveBeenCalledWith("/price-drops");
    expect(deleteCachedByPrefixMock).toHaveBeenCalledWith("cache:housing:");
  });

  it("temporarily accepts the legacy query-string secret", async () => {
    const req = request(
      "http://localhost/api/revalidate?secret=test-revalidation-secret&path=/housing",
    );

    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(revalidatePathMock).toHaveBeenCalledWith("/housing");
  });

  it("prefers a supplied header over the legacy query fallback", async () => {
    const req = request(
      "http://localhost/api/revalidate?secret=test-revalidation-secret&path=/housing",
      "wrong",
    );

    const response = await POST(req);

    expect(response.status).toBe(401);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("reports a successful flush as revalidated with no errors", async () => {
    deleteCachedByPrefixMock.mockResolvedValue({ deleted: 7, errors: [], scanIterations: 3 });
    const req = request(
      "http://localhost/api/revalidate?flush=shorts",
      "test-revalidation-secret",
    );

    const response = await POST(req);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.revalidated).toBe(true);
    expect(body.flushedKeys).toBe(7);
    expect(body.flushErrors).toEqual([]);
  });

  // The 2026-08-21 freeze: Upstash rejected every DEL while still serving reads,
  // the flush swallowed the error and returned 0, and this route kept answering
  // `revalidated: true`. HTTP stays 200 (callers are best-effort) but the body
  // must be honest.
  it("surfaces flush failures in the body while keeping HTTP 200", async () => {
    deleteCachedByPrefixMock.mockResolvedValue({
      deleted: 0,
      errors: ["cache:shorts:: ERR max requests limit exceeded"],
      scanIterations: 1,
    });
    const req = request(
      "http://localhost/api/revalidate?path=/top&flush=shorts",
      "test-revalidation-secret",
    );

    const response = await POST(req);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.revalidated).toBe(false);
    expect(body.flushedKeys).toBe(0);
    expect(body.flushErrors).toEqual([
      "cache:shorts:: ERR max requests limit exceeded",
    ]);
  });

  it.each(["wrong", "test-revalidation-secret-extra"])(
    "rejects a mismatched secret without throwing (%s)",
    async (secret) => {
      const req = request(
        "http://localhost/api/revalidate?path=/housing",
        secret,
      );

      const response = await POST(req);

      expect(response.status).toBe(401);
      expect(revalidatePathMock).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["report-2026-W20", "/reports/weekly/10-most-shorted-asx-stocks-week-20-2026"],
    ["report-2026-W01", "/reports/weekly/10-most-shorted-asx-stocks-week-1-2026"],
    ["report-2026-05", "/reports/monthly/2026-05"],
    ["report-2025", "/reports/yearly/2025"],
  ])("refreshes the archive and negative route entry on publication: %s", async (tag, path) => {
    const response = await POST(request(`http://localhost/api/revalidate?tag=${tag}`, "test-revalidation-secret"));
    expect(response.status).toBe(200);
    expect(revalidateTagMock).toHaveBeenCalledWith("reports-index");
    expect(revalidatePathMock).toHaveBeenCalledWith(path);
  });

  it.each(["tag=shorts-data", "flush=shorts"])("invalidates corrected and previously missing historical snapshots: %s", async (query) => {
    await POST(request(`http://localhost/api/revalidate?${query}`, "test-revalidation-secret"));
    expect(revalidateTagMock).toHaveBeenCalledWith("shorts-data");
    expect(revalidateTagMock).toHaveBeenCalledWith("market-index");
    expect(revalidatePathMock).toHaveBeenCalledWith("/market");
    for (const path of ["/market/[date]", "/reports/weekly/[slug]", "/reports/monthly/[slug]", "/reports/yearly/[slug]"]) {
      expect(revalidatePathMock).toHaveBeenCalledWith(path, "page");
    }
  });

  it("clears a negative market date entry on targeted correction", async () => {
    await POST(request("http://localhost/api/revalidate?tag=market-date:2026-09-30", "test-revalidation-secret"));
    expect(revalidatePathMock).toHaveBeenCalledWith("/market/2026-09-30");
    expect(revalidateTagMock).toHaveBeenCalledWith("market-index");
    expect(revalidatePathMock).toHaveBeenCalledWith("/market");
    expect(revalidatePathMock).not.toHaveBeenCalledWith("/market/[date]", "page");
  });

  // On Vercel a plain revalidatePath("/") expired every page on the site
  // (measured 2026-11-09). "/" must reach the home page only.
  it("expires the home page alone for path=/, never the whole site", async () => {
    const res = await POST(
      request("http://localhost/api/revalidate?tag=news-index&path=/news,/news/a-take,/", "test-revalidation-secret"),
    );
    expect(res.status).toBe(200);
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "page");
    expect(revalidatePathMock).not.toHaveBeenCalledWith("/");
    expect(revalidatePathMock).not.toHaveBeenCalledWith("/", "layout");
    expect(revalidatePathMock).toHaveBeenCalledWith("/news/a-take");
  });

  it("expires every tab under a stock with one layout-typed call", async () => {
    const res = await POST(
      request(
        "http://localhost/api/revalidate?path=/shorts/[stockCode],/market/[date]",
        "test-revalidation-secret",
      ),
    );
    expect(res.status).toBe(200);
    expect(revalidatePathMock).toHaveBeenCalledWith("/shorts/[stockCode]", "layout");
    expect(revalidatePathMock).toHaveBeenCalledWith("/market/[date]", "page");
  });

  describe("a shorts sync that names what it wrote", () => {
    const SYNC =
      "http://localhost/api/revalidate?tag=scan-results&path=/,/top,/news,/screener,/industry,/statistics,/scans&flush=shorts";
    const change = (codes: string[], dates: string[]) => JSON.stringify({ shorts: { codes, dates } });
    const tagsCalled = () => revalidateTagMock.mock.calls.map(([tag]) => tag as string);
    const pathsCalled = () => revalidatePathMock.mock.calls.map((args) => args as [string, string?]);

    it("expires only the written stocks, dates and report periods", async () => {
      const res = await POST(
        request(SYNC, "test-revalidation-secret", change(["BHP", "cba"], ["2026-11-03"])),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(tagsCalled()).toEqual(
        expect.arrayContaining([
          "scan-results",
          "shorts-latest",
          "market-index",
          "market-date:2026-11-03",
          "report-2026-W45",
          "report-2026-11",
          "report-2026",
          "stock:BHP",
          "stock:CBA",
        ]),
      );
      expect(tagsCalled()).not.toContain("shorts-data");
      expect(tagsCalled()).not.toContain("reports-index");
      expect(pathsCalled()).toEqual(
        expect.arrayContaining([
          ["/", "page"],
          ["/top"],
          ["/market"],
          ["/market/2026-11-03"],
          ["/reports/weekly/10-most-shorted-asx-stocks-week-45-2026"],
          ["/reports/monthly/2026-11"],
          ["/reports/yearly/2026"],
        ]),
      );
      // No pattern: not every stock page, market date or report.
      expect(pathsCalled().filter(([p]) => p.includes("["))).toEqual([]);
      // The KV family is still flushed.
      expect(deleteCachedByPrefixMock).toHaveBeenCalledWith("cache:shorts:");
      expect(body.shorts).toEqual({ scope: "narrow", stocks: 2, dates: ["2026-11-03"] });
      // Per-stock tags are counted in the body, not listed.
      expect(body.tags).not.toContain("stock:BHP");
    });

    it("goes broad when the caller also asks for the broad tag", async () => {
      await POST(
        request(
          "http://localhost/api/revalidate?tag=shorts-data",
          "test-revalidation-secret",
          change(["BHP"], ["2026-11-03"]),
        ),
      );
      expect(tagsCalled()).toContain("shorts-data");
      expect(tagsCalled()).not.toContain("stock:BHP");
      expect(revalidatePathMock).toHaveBeenCalledWith("/market/[date]", "page");
    });

    it("goes broad, and says why, when the change set cannot be trusted", async () => {
      const res = await POST(
        request(SYNC, "test-revalidation-secret", change(["BHP"], ["2026-02-30"])),
      );
      expect(tagsCalled()).toContain("shorts-data");
      expect(revalidatePathMock).toHaveBeenCalledWith("/reports/weekly/[slug]", "page");
      expect((await res.json()).shorts).toEqual({ scope: "broad", reason: "a date is not YYYY-MM-DD" });
    });

    it("goes broad on flush=shorts with a body that does not parse", async () => {
      await POST(request(SYNC, "test-revalidation-secret", "{not json"));
      expect(tagsCalled()).toContain("shorts-data");
    });

    it("ignores a body that names no change set on a request that is not a shorts event", async () => {
      const res = await POST(
        request("http://localhost/api/revalidate?path=/housing", "test-revalidation-secret", "{not json"),
      );
      expect(tagsCalled()).toEqual([]);
      expect(pathsCalled()).toEqual([["/housing"]]);
      expect((await res.json()).shorts).toBeNull();
    });
  });
});
