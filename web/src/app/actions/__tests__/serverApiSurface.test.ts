/// <reference types="jest" />
import fs from "node:fs";
import path from "node:path";

describe("server API surface", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  const webRoot = path.resolve(__dirname, "../../../..");

  function withoutTestingBypassEnv() {
    const env = { ...originalEnv };
    delete env.SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET;
    delete env.TF_VAR_rate_limit_testing_bypass_secret;
    return env;
  }

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

  it("falls back to the public edge API on Vercel when no direct shorts origin is configured", async () => {
    process.env = {
      ...originalEnv,
      VERCEL: "1",
      VERCEL_ENV: "preview",
      SHORTS_SERVICE_ENDPOINT: "",
      NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT: "",
      SHORTS_API_URL: "",
      NEXT_PUBLIC_API_URL: "",
    };

    const { SHORTS_API_URL, SERVER_SHORTS_API_URL, getServerShortsApiUrl } =
      await import("../config");

    expect(getServerShortsApiUrl()).toBe("https://api.shorted.com.au");
    expect(SERVER_SHORTS_API_URL).toBe("https://api.shorted.com.au");
    expect(SHORTS_API_URL).toBe("https://api.shorted.com.au");
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
      ...withoutTestingBypassEnv(),
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
    // company-metadata.ts intentionally absent: it now delegates to
    // getStockDetails() and inherits its unstable_cache identity instead of
    // double-fetching the same RPC under a second cache key.
    const files = [
      "src/app/actions/getStock.ts",
      "src/app/actions/getStockDetails.ts",
      "src/app/actions/getStockData.ts",
    ];

    for (const file of files) {
      const source = fs.readFileSync(path.join(webRoot, file), "utf8");
      expect(source).toContain("unstable_cache");
      expect(source).toContain("STOCK_PAGE_CACHE_SECONDS");
      expect(source).toContain("revalidate: STOCK_PAGE_CACHE_SECONDS");
    }

    // The delegation itself must stay in place.
    const companyMetadata = fs.readFileSync(
      path.join(webRoot, "src/app/actions/company-metadata.ts"),
      "utf8",
    );
    expect(companyMetadata).toContain('from "./getStockDetails"');
    expect(companyMetadata).not.toContain("createConnectTransport");
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
      "src/@/lib/seo/sitemap-sections.ts",
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

  // -------------------------------------------------------------------------
  // First-party identity (the August 2026 self-inflicted rate limit)
  // -------------------------------------------------------------------------

  it("routes every server-side Connect transport through an SSR-marked fetcher", () => {
    // A transport that builds its own `fetch` sends NEITHER the first-party
    // user-agent NOR the bypass secret, so its requests are indistinguishable
    // from a scraper at the Cloudflare edge. That is not a hypothetical: the
    // whole reason ~3,500 of our own requests a day were 429'd is that some
    // first-party traffic could not prove it was first-party. Catch a new
    // transport that forgets the fetcher at review time, not in Cloudflare
    // analytics three weeks later.
    const approvedFetchers = [
      "serverFetchWithUserAgent",
      "serverFetchOutsideNextCache",
    ];
    const violations: string[] = [];

    const visit = (absolutePath: string) => {
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        if (
          absolutePath.endsWith(`${path.sep}__tests__`) ||
          // actions/client/* are the browser-side twins of the server actions:
          // relative baseUrl, dispatched from the user's browser through the
          // Next.js rewrites, where middleware.ts stamps the marker instead.
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
      const content = fs.readFileSync(absolutePath, "utf8");
      if (!content.includes("createConnectTransport(")) return;
      // Client components run in the browser: they use relative URLs through
      // the Next.js rewrites, and middleware.ts stamps the marker for them.
      if (/^\s*["']use client["']/m.test(content)) return;
      // A transport with a relative baseUrl never leaves the browser either.
      if (/baseUrl:\s*""/.test(content)) return;

      const usesApprovedFetcher = approvedFetchers.some((name) =>
        content.includes(name),
      );
      if (!usesApprovedFetcher) {
        violations.push(path.relative(webRoot, absolutePath));
      }
    };

    visit(path.join(webRoot, "src/app"));

    expect(violations).toEqual([]);
  });

  it("shouts once when a production process talks to a shorted API origin without the bypass secret", async () => {
    process.env = {
      ...withoutTestingBypassEnv(),
      VERCEL: "1",
      SHORTED_SSR_BYPASS_SECRET: "",
    };
    const fetchMock = jest.fn().mockResolvedValue(new Response("{}"));
    global.fetch = fetchMock;
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const { serverFetchWithUserAgent } = await import("../config");
    await serverFetchWithUserAgent("https://api.shorted.com.au/health");
    await serverFetchWithUserAgent("https://api.shorted.com.au/health");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
      "SHORTED_SSR_BYPASS_SECRET",
    );
    // The request still goes out — a missing secret must never be fatal.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it("stays quiet in local development and for third-party hosts", async () => {
    process.env = {
      ...withoutTestingBypassEnv(),
      SHORTED_SSR_BYPASS_SECRET: "",
      VERCEL: "",
      VERCEL_ENV: "",
      VERCEL_REGION: "",
      CI: "",
    };
    global.fetch = jest.fn().mockResolvedValue(new Response("{}"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const { serverFetchWithUserAgent } = await import("../config");
    await serverFetchWithUserAgent("https://api.shorted.com.au/health");
    await serverFetchWithUserAgent("https://example.com/health");

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("never sends the bypass secret to a host that is not a shorted API origin", async () => {
    process.env = {
      ...withoutTestingBypassEnv(),
      VERCEL: "1",
      SHORTED_SSR_BYPASS_SECRET: "super-secret",
    };
    const fetchMock = jest.fn().mockResolvedValue(new Response("{}"));
    global.fetch = fetchMock;

    const { serverFetchWithUserAgent } = await import("../config");
    await serverFetchWithUserAgent("https://example.com/anything");

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("X-Shorted-Ssr-Bypass")).toBeNull();
  });
});
