/// <reference types="jest" />
import fs from "node:fs";
import path from "node:path";

describe("server API surface", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  const webRoot = path.resolve(__dirname, "../../../..");

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.resetModules();
  });

  it("resolves legacy server action API exports to the direct service before the public Cloudflare API host", async () => {
    process.env = {
      ...originalEnv,
      SHORTS_SERVICE_ENDPOINT: "",
      SHORTS_API_URL: "https://api.shorted.com.au",
      NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT: "https://shorts-prod.run.app",
      NEXT_PUBLIC_API_URL: "https://api.shorted.com.au",
    };

    const { SHORTS_API_URL, SERVER_SHORTS_API_URL, getServerShortsApiUrl } =
      await import("../config");

    expect(getServerShortsApiUrl()).toBe("https://shorts-prod.run.app");
    expect(SERVER_SHORTS_API_URL).toBe("https://shorts-prod.run.app");
    expect(SHORTS_API_URL).toBe("https://shorts-prod.run.app");
  });

  it("normalizes configured API base URLs before server fetches and rewrites use them", async () => {
    process.env = {
      ...originalEnv,
      SHORTS_SERVICE_ENDPOINT: " https://shorts-prod.run.app\n ",
      NEXT_PUBLIC_MARKET_DATA_API_URL:
        " https://market-data-prod.run.app\r\n ",
    };

    const {
      MARKET_DATA_API_URL,
      SHORTS_API_URL,
      buildApiUrl,
      normalizeApiBaseUrl,
    } = await import("../config");

    expect(normalizeApiBaseUrl(" https://api.shorted.com.au\n ")).toBe(
      "https://api.shorted.com.au",
    );
    expect(SHORTS_API_URL).toBe("https://shorts-prod.run.app");
    expect(MARKET_DATA_API_URL).toBe("https://market-data-prod.run.app");
    expect(
      buildApiUrl(
        " https://api.shorted.com.au\n ",
        "/shorts.v1alpha1.ShortedStocksService/GetStock",
      ),
    ).toBe(
      "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStock",
    );
  });

  it("sends both documented Cloudflare testing bypass headers when a bypass secret is configured", async () => {
    process.env = {
      ...originalEnv,
      SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET: "test-secret",
    };
    const fetchMock = jest.fn().mockResolvedValue(new Response("{}"));
    global.fetch = fetchMock;

    const { serverFetchWithUserAgent } = await import("../config");
    await serverFetchWithUserAgent("https://api.shorted.com.au/health");

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("User-Agent")).toContain("Shorted-E2E/1.0");
    expect(headers.get("X-Shorted-Testing-Bypass")).toBe("test-secret");
  });

  it("normalizes server fetch URLs and disables Next fetch caching for Connect POST streams", async () => {
    process.env = {
      ...originalEnv,
      VERCEL_REGION: "iad1",
    };
    const fetchMock = jest.fn().mockResolvedValue(new Response("{}"));
    global.fetch = fetchMock;

    const { serverFetchWithUserAgent } = await import("../config");
    const request = new Request(
      "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStock",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productCode: "BHP" }),
      },
    );

    await serverFetchWithUserAgent(request);

    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe("no-store");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("User-Agent")).toBe(
      "shorted-web-ssr/1.0 (+https://shorted.com.au)",
    );

    await serverFetchWithUserAgent(
      "https://api.shorted.com.au\n/shorts.v1alpha1.ShortedStocksService/GetStock",
      { method: "POST", body: "{}" },
    );

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStock",
    );
    expect(fetchMock.mock.calls[1]?.[1]?.cache).toBe("no-store");
  });

  it("does not force no-store during static generation/build contexts", async () => {
    process.env = {
      ...originalEnv,
    };
    const fetchMock = jest.fn().mockResolvedValue(new Response("{}"));
    global.fetch = fetchMock;

    const { serverFetchWithUserAgent } = await import("../config");

    await serverFetchWithUserAgent(
      "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStock",
      { method: "POST", body: "{}" },
    );

    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBeUndefined();
  });

  it("respects explicit fetch cache options when callers intentionally opt into Next caching", async () => {
    process.env = {
      ...originalEnv,
    };
    const fetchMock = jest.fn().mockResolvedValue(new Response("{}"));
    global.fetch = fetchMock;

    const { serverFetchWithUserAgent } = await import("../config");

    await serverFetchWithUserAgent(
      "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
      {
        method: "POST",
        body: "{}",
        next: { revalidate: 3600 },
      } as RequestInit & { next: { revalidate: number } },
    );

    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBeUndefined();
    expect(
      (fetchMock.mock.calls[0]?.[1] as RequestInit & { next?: unknown })?.next,
    ).toEqual({ revalidate: 3600 });
  });

  it("routes per-stock SSR API calls to the direct service endpoint, not Cloudflare", async () => {
    process.env = {
      ...originalEnv,
      SHORTS_SERVICE_ENDPOINT: "",
      NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT: "https://shorts-prod.run.app",
      NEXT_PUBLIC_API_URL: "https://api.shorted.com.au\n",
    };

    const transports: Array<{ baseUrl?: string; fetch?: unknown }> = [];
    const getStock = jest.fn().mockResolvedValue({ productCode: "LOT" });
    const getStockDetails = jest.fn().mockResolvedValue({
      productCode: "LOT",
      companyName: "Lotus Resources",
      enrichmentStatus: "completed",
    });

    jest.doMock("@connectrpc/connect-web", () => ({
      createConnectTransport: jest.fn((options) => {
        transports.push(options);
        return options;
      }),
    }));
    jest.doMock("@connectrpc/connect", () => ({
      createClient: jest.fn(() => ({
        getStock,
        getStockDetails,
      })),
    }));
    jest.doMock("next/cache", () => ({
      unstable_cache: (loader: () => Promise<unknown>) => loader,
      revalidatePath: jest.fn(),
      revalidateTag: jest.fn(),
    }));
    jest.unmock("~/app/actions/getStock");

    const { getStockOrNotFound } = await import("../getStock");
    const { getStockDetails: fetchStockDetails } =
      await import("../getStockDetails");
    const { getEnrichedCompanyMetadata } =
      await import("../company-metadata");

    await getStockOrNotFound("LOT");
    await fetchStockDetails("LOT");
    await getEnrichedCompanyMetadata("LOT");

    expect(transports.map((transport) => transport.baseUrl)).toEqual([
      "https://shorts-prod.run.app",
      "https://shorts-prod.run.app",
      "https://shorts-prod.run.app",
    ]);
    expect(transports.every((transport) => typeof transport.fetch === "function"))
      .toBe(true);
    expect(getStock).toHaveBeenCalledWith({ productCode: "LOT" });
    expect(getStockDetails).toHaveBeenCalledWith({ productCode: "LOT" });
  });

  it("routes market-data app API proxies through the direct server origin with cacheable server fetches", () => {
    const files = [
      "src/app/api/market-data/historical/route.ts",
      "src/app/api/market-data/correlations/route.ts",
      "src/app/api/market-data/multiple-quotes/route.ts",
    ];

    for (const file of files) {
      const source = fs.readFileSync(path.join(webRoot, file), "utf8");
      expect(source).toContain("getServerMarketDataApiUrl");
      expect(source).toContain("serverFetchWithUserAgent");
      expect(source).not.toContain("getMarketDataApiUrl");
    }
  });

  it("keeps per-stock page data in persistent caches rather than only per-render React cache", () => {
    const files = [
      "src/app/actions/getStock.ts",
      "src/app/actions/getStockDetails.ts",
      "src/app/actions/getStockData.ts",
      "src/app/actions/company-metadata.ts",
    ];

    for (const file of files) {
      const source = fs.readFileSync(path.join(webRoot, file), "utf8");
      expect(source).toContain("unstable_cache");
      expect(source).toContain("STOCK_PAGE_CACHE_SECONDS");
      expect(source).toContain("revalidate: STOCK_PAGE_CACHE_SECONDS");
    }
  });

  it("does not prioritize NEXT_PUBLIC_API_URL before the direct service endpoint in server-side API callers", () => {
    const roots = [
      "src/app/actions",
      "src/app/api",
      "src/app/shorts",
      "src/app/market",
      "src/app/reports",
      "src/app/industry",
      "src/app/search",
      "src/app/directory",
      "src/app/sitemap.ts",
      "src/server",
    ];
    const allowed = new Set([
      "src/app/actions/__tests__/serverApiSurface.test.ts",
      "src/app/actions/config.ts",
    ]);
    const violations: string[] = [];

    const visit = (absolutePath: string) => {
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        if (
          absolutePath.endsWith(`${path.sep}__tests__`) ||
          absolutePath.endsWith(`${path.sep}client`)
        ) {
          return;
        }
        for (const entry of fs.readdirSync(absolutePath)) {
          visit(path.join(absolutePath, entry));
        }
        return;
      }

      if (!/\.(ts|tsx)$/.test(absolutePath)) return;
      const relativePath = path.relative(webRoot, absolutePath);
      if (allowed.has(relativePath)) return;

      const content = fs.readFileSync(absolutePath, "utf8");
      if (
        /process\.env\.NEXT_PUBLIC_API_URL\s*\?\?\s*process\.env\.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT/.test(
          content,
        )
        || /process\.env\.(?:NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT|NEXT_PUBLIC_API_URL|SHORTS_SERVICE_ENDPOINT|SHORTS_API_URL)/.test(
          content,
        )
      ) {
        violations.push(relativePath);
      }
    };

    for (const root of roots) {
      visit(path.join(webRoot, root));
    }

    expect(violations).toEqual([]);
  });
});
