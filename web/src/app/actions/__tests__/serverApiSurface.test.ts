/// <reference types="jest" />
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

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

  // -------------------------------------------------------------------------
  // ISR safety (the /battlegrounds regeneration that never landed)
  // -------------------------------------------------------------------------

  describe("transports an ISR route reaches", () => {
    // At Vercel runtime serverFetchWithUserAgent forces `cache: "no-store"` on
    // a POST that carries no `next` option. Inside a static render (a build
    // prerender or an ISR regeneration) that fetch throws DynamicServerError,
    // and Next discards the render even when the caller swallows the error.
    // /battlegrounds sat STALE with a frozen `age` for exactly this reason
    // (2026-10-21), as /economy did on 2026-07-22. A transport a static route
    // can reach must either give its fetch a lifetime (`next: { revalidate }`)
    // or bypass Next's patched fetch (serverFetchOutsideNextCache, for reads
    // that cache themselves in unstable_cache).
    //
    // Reachability is the static import graph from every route file that Next
    // generates statically: page, layout and image files that do not opt out
    // with `dynamic = "force-dynamic"` or `revalidate = 0` and do not read
    // searchParams. Client modules end the walk: their reads run in the
    // browser, through the rewrites. The check is per FILE: a module that
    // holds an untagged transport fails when any static route imports it,
    // whichever of its functions that route calls.

    /**
     * Untagged transports that static routes reach, each with why it stays and
     * the fix that deletes its line. Empty since 2026-10-21: getIndustryTreeMap
     * tags its fallback read, and getHousing.ts lost its untagged
     * createHousingClient with the two server reads nothing called.
     */
    const ALLOWED_UNTAGGED: Record<string, string> = {};

    const appDir = path.join(webRoot, "src/app");
    const srcDir = path.join(webRoot, "src");
    const ROUTE_FILE = /^(page|layout|opengraph-image|twitter-image)\.tsx?$/;
    const ISR_SAFE_FETCH = /\bnext\s*:\s*\{[^}]*\brevalidate\s*:/;

    const parse = (file: string): ts.SourceFile =>
      ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );

    const isClientModule = (sf: ts.SourceFile): boolean =>
      sf.statements.some(
        (s) =>
          ts.isExpressionStatement(s) &&
          ts.isStringLiteral(s.expression) &&
          s.expression.text === "use client",
      );

    /** Every node of the tree, depth first. */
    function* nodes(root: ts.Node): Generator<ts.Node> {
      yield root;
      for (const child of root.getChildren()) yield* nodes(child);
    }

    /** `export const <name> = <literal>` initializer text, if the module has one. */
    const exportedConst = (sf: ts.SourceFile, name: string): string | undefined => {
      for (const s of sf.statements) {
        if (!ts.isVariableStatement(s)) continue;
        if (!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) {
            return d.initializer?.getText(sf);
          }
        }
      }
      return undefined;
    };

    /** A route file Next renders per request, so its reads may be no-store. */
    const rendersPerRequest = (sf: ts.SourceFile): boolean =>
      /^["'`]force-dynamic["'`]$/.test(exportedConst(sf, "dynamic") ?? "") ||
      exportedConst(sf, "revalidate") === "0" ||
      [...nodes(sf)].some((n) => ts.isIdentifier(n) && n.text === "searchParams");

    /** Runtime imports: type-only imports and re-exports are not edges. */
    const runtimeImports = (sf: ts.SourceFile): string[] => {
      const specifiers: string[] = [];
      for (const n of nodes(sf)) {
        if (
          ts.isImportDeclaration(n) &&
          !n.importClause?.isTypeOnly &&
          ts.isStringLiteral(n.moduleSpecifier)
        ) {
          specifiers.push(n.moduleSpecifier.text);
        } else if (
          ts.isExportDeclaration(n) &&
          !n.isTypeOnly &&
          n.moduleSpecifier &&
          ts.isStringLiteral(n.moduleSpecifier)
        ) {
          specifiers.push(n.moduleSpecifier.text);
        } else if (
          ts.isCallExpression(n) &&
          n.expression.kind === ts.SyntaxKind.ImportKeyword &&
          n.arguments[0] &&
          ts.isStringLiteral(n.arguments[0])
        ) {
          specifiers.push(n.arguments[0].text);
        }
      }
      return specifiers;
    };

    const resolveImport = (from: string, specifier: string): string | undefined => {
      const base = specifier.startsWith("~/")
        ? path.join(srcDir, specifier.slice(2))
        : specifier.startsWith("@/")
          ? path.join(srcDir, "@", specifier.slice(2))
          : specifier.startsWith(".")
            ? path.resolve(path.dirname(from), specifier)
            : undefined;
      if (!base) return undefined; // a package
      return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]
        .find((candidate) => /\.tsx?$/.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    };

    /** Each createConnectTransport call's `fetch`, and whether it is ISR-safe. */
    const transportFetches = (sf: ts.SourceFile): Array<{ fetch: string; safe: boolean }> => {
      const declarationText = (name: string): string | undefined => {
        for (const n of nodes(sf)) {
          if (
            (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n)) &&
            n.name &&
            ts.isIdentifier(n.name) &&
            n.name.text === name
          ) {
            return n.getText(sf);
          }
        }
        return undefined;
      };
      const isSafe = (text: string | undefined): boolean =>
        text !== undefined &&
        (ISR_SAFE_FETCH.test(text) || text.includes("serverFetchOutsideNextCache"));

      const found: Array<{ fetch: string; safe: boolean }> = [];
      for (const n of nodes(sf)) {
        if (
          !ts.isCallExpression(n) ||
          !ts.isIdentifier(n.expression) ||
          n.expression.text !== "createConnectTransport"
        ) {
          continue;
        }
        const options = n.arguments[0];
        const property =
          options && ts.isObjectLiteralExpression(options)
            ? options.properties.find((p) => p.name?.getText(sf) === "fetch")
            : undefined;
        if (!property || !ts.isPropertyAssignment(property)) {
          found.push({ fetch: "(global fetch)", safe: false });
          continue;
        }
        const value = property.initializer;
        if (ts.isIdentifier(value)) {
          found.push({
            fetch: value.text,
            safe: value.text === "serverFetchOutsideNextCache" || isSafe(declarationText(value.text)),
          });
        } else {
          found.push({ fetch: "(inline)", safe: isSafe(value.getText(sf)) });
        }
      }
      return found;
    };

    const routeFiles = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "__tests__" ? [] : routeFiles(full);
        return ROUTE_FILE.test(entry.name) ? [full] : [];
      });

    /** [module, the route that reached it] for every server module static routes reach. */
    let reachedCache: Map<string, string> | undefined;
    const reachedFromStaticRoutes = (): Map<string, string> => {
      if (reachedCache) return reachedCache;
      const reached = new Map<string, string>();
      const queue: Array<[file: string, route: string]> = [];
      for (const file of routeFiles(appDir)) {
        const sf = parse(file);
        if (isClientModule(sf) || rendersPerRequest(sf)) continue;
        queue.push([file, path.relative(webRoot, file)]);
      }
      while (queue.length > 0) {
        const [file, route] = queue.shift()!;
        if (reached.has(file)) continue;
        const sf = parse(file);
        if (isClientModule(sf)) continue;
        reached.set(file, route);
        for (const specifier of runtimeImports(sf)) {
          const target = resolveImport(file, specifier);
          if (target && !target.includes(`${path.sep}gen${path.sep}`) && !reached.has(target)) {
            queue.push([target, route]);
          }
        }
      }
      reachedCache = reached;
      return reached;
    };

    it("reaches the route files and the actions they read", () => {
      const reached = [...reachedFromStaticRoutes().keys()].map((f) => path.relative(webRoot, f));
      expect(reached).toEqual(
        expect.arrayContaining([
          "src/app/battlegrounds/page.tsx",
          "src/app/actions/getBattlegrounds.ts",
          "src/app/actions/getShortStatistics.ts",
          "src/app/actions/getEconomy.ts",
        ]),
      );
      // Per-request routes are not entries: /search reads searchParams.
      expect(reached).not.toContain("src/app/search/page.tsx");
    });

    it("tags or bypasses the patched fetch on every transport a static route reaches", () => {
      const violations: string[] = [];
      for (const [file, route] of reachedFromStaticRoutes()) {
        const relative = path.relative(webRoot, file);
        if (relative in ALLOWED_UNTAGGED) continue;
        if (!fs.readFileSync(file, "utf8").includes("createConnectTransport(")) continue;
        for (const { fetch, safe } of transportFetches(parse(file))) {
          if (!safe) violations.push(`${relative} (fetch: ${fetch}), reached from ${route}`);
        }
      }
      expect(violations).toEqual([]);
    });

    it("allows only untagged transports that still exist and are still reached", () => {
      const reached = reachedFromStaticRoutes();
      for (const relative of Object.keys(ALLOWED_UNTAGGED)) {
        const file = path.join(webRoot, relative);
        expect(reached.has(file)).toBe(true);
        expect(transportFetches(parse(file)).some(({ safe }) => !safe)).toBe(true);
      }
    });

    it("tells a tagged or bypassing fetch from an untagged one", () => {
      const fixture = (code: string) =>
        transportFetches(
          ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
        );
      expect(fixture("createConnectTransport({ fetch: serverFetchOutsideNextCache, baseUrl });")).toEqual([
        { fetch: "serverFetchOutsideNextCache", safe: true },
      ]);
      expect(
        fixture(
          "const isrFetch: typeof fetch = (input, init) => serverFetchWithUserAgent(input, { ...init, next: { revalidate: 3600, tags: ['shorts-data'] } });\n" +
            "createConnectTransport({ fetch: isrFetch, baseUrl });",
        ),
      ).toEqual([{ fetch: "isrFetch", safe: true }]);
      expect(
        fixture("createConnectTransport({ fetch: (i, init) => serverFetchWithUserAgent(i, { ...init, next: { revalidate: 60 } }), baseUrl });"),
      ).toEqual([{ fetch: "(inline)", safe: true }]);
      expect(fixture("createConnectTransport({ fetch: serverFetchWithUserAgent, baseUrl });")).toEqual([
        { fetch: "serverFetchWithUserAgent", safe: false },
      ]);
      // A tag alone is not a no-store POST: any `next` option skips the
      // override, and Next's "auto cache" gives the fetch the route's
      // revalidate. It still fails the check, which asks each transport to
      // state its own lifetime rather than inherit one from whichever route
      // renders it.
      expect(
        fixture(
          "const tagged = (i, init) => serverFetchWithUserAgent(i, { ...init, next: { tags: ['x'] } });\n" +
            "createConnectTransport({ fetch: tagged, baseUrl });",
        ),
      ).toEqual([{ fetch: "tagged", safe: false }]);
      expect(fixture("createConnectTransport({ baseUrl });")).toEqual([
        { fetch: "(global fetch)", safe: false },
      ]);
    });
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
