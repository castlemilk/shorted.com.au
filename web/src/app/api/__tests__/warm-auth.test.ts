/** @jest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type NextRequest } from "next/server";
import * as aboutRoute from "../about/warm-cache/route";
import * as homepageRoute from "../homepage/warm-cache/route";
import * as pagesRoute from "../pages/warm-cache/route";
import * as staticPagesRoute from "../static-pages/warm-cache/route";
import * as warmPagesRoute from "../warm-pages/route";

jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));

jest.mock("~/app/actions/getTopShorts", () => ({
  getTopShortsData: jest.fn().mockResolvedValue({ timeSeries: [] }),
}));
jest.mock("~/app/actions/getIndustryTreeMap", () => ({
  getIndustryTreeMap: jest.fn().mockResolvedValue({ industries: [] }),
}));
jest.mock("~/@/lib/kv-cache", () => ({
  CACHE_KEYS: { topStocks: (limit: number) => `stocks:${limit}` },
  setCached: jest.fn().mockResolvedValue(true),
}));
jest.mock("~/lib/statistics", () => ({
  fetchAndCacheStatistics: jest.fn().mockResolvedValue({ companyCount: 1, industryCount: 1 }),
}));
jest.mock("~/app/actions/config", () => ({
  SHORTS_API_URL: "http://localhost:9091",
  buildApiUrl: jest.fn(),
  serverFetchWithUserAgent: jest.fn(),
}));

type WarmGet = (request: NextRequest) => Promise<Response>;

const WARM_ENV = [
  "CACHE_WARM_SECRET",
  "CRON_SECRET",
  "REVALIDATION_SECRET",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_REGION",
] as const;
const SECRETS = {
  CACHE_WARM_SECRET: "test-warm-secret",
  CRON_SECRET: "test-cron-secret",
  REVALIDATION_SECRET: "test-reval-secret",
};

// The five routes answer the same way, so one matrix covers all of them.
const ROUTES: Array<[string, WarmGet]> = [
  ["about", aboutRoute.GET],
  ["homepage", homepageRoute.GET],
  ["pages", pagesRoute.GET],
  ["pages invalidation", pagesRoute.POST],
  ["static-pages", staticPagesRoute.GET],
  ["warm-pages", warmPagesRoute.GET],
];

function request(search = "", headers: Record<string, string> = {}): NextRequest {
  const nextUrl = new URL(`http://localhost/api/warm-cache${search}`);
  return { nextUrl, url: nextUrl.toString(), headers: new Headers(headers) } as unknown as NextRequest;
}

function page() {
  return { ok: true, status: 200, headers: new Headers(), text: async () => "<main>Ready</main>", json: async () => ({ invalidated: true }) };
}

describe.each(ROUTES)("%s warm authentication", (_name, warm) => {
  const saved: Partial<Record<(typeof WARM_ENV)[number], string>> = {};
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    for (const key of WARM_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    Object.assign(process.env, SECRETS);
    fetchMock = jest.fn().mockResolvedValue(page());
    global.fetch = fetchMock;
  });

  afterEach(() => {
    for (const key of WARM_ENV) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = originalFetch;
  });

  it.each<[string, string, Record<string, string>]>([
    ["the warm header", "", { "X-Cache-Warm-Secret": "test-warm-secret" }],
    ["Vercel cron's bearer", "", { Authorization: "Bearer test-cron-secret" }],
    ["the deploy's revalidation bearer", "", { Authorization: "Bearer test-reval-secret" }],
  ])("accepts %s", async (_kind, search, headers) => {
    expect((await warm(request(search, headers))).status).toBe(200);
  });

  it.each<[string, string, Record<string, string>]>([
    ["no credential", "", {}],
    ["a wrong bearer", "", { Authorization: "Bearer invalid" }],
    ["the warm secret as a bearer", "", { Authorization: "Bearer test-warm-secret" }],
    ["the cron secret as the warm header", "", { "X-Cache-Warm-Secret": "test-cron-secret" }],
    ["the right secret under Basic", "", { Authorization: "Basic test-cron-secret" }],
    ["a bare token with no scheme", "", { Authorization: "test-cron-secret" }],
    ["a lower-case scheme", "", { Authorization: "bearer test-cron-secret" }],
    ["the warm secret in the query string", "?secret=test-warm-secret", {}],
    ["the cron secret in the query string", "?secret=test-cron-secret", {}],
    ["a correct query secret beside a wrong header", "?secret=test-warm-secret", { "X-Cache-Warm-Secret": "invalid" }],
  ])("refuses %s before warming", async (_kind, search, headers) => {
    expect((await warm(request(search, headers))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers everyone off Vercel when no credential is configured", async () => {
    for (const key of WARM_ENV) delete process.env[key];
    expect((await warm(request())).status).toBe(200);
  });

  it("refuses every request on Vercel when no credential is configured", async () => {
    for (const key of WARM_ENV) delete process.env[key];
    process.env.VERCEL = "1";
    expect((await warm(request("", { Authorization: "Bearer anything" }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("warm-cache route contract", () => {
  const modules: Array<[string, { dynamic?: string }]> = [
    ["about", aboutRoute],
    ["homepage", homepageRoute],
    ["pages", pagesRoute],
    ["static-pages", staticPagesRoute],
    ["warm-pages", warmPagesRoute],
  ];

  it.each(modules)("%s is force-dynamic", (_name, route) => {
    expect(route.dynamic).toBe("force-dynamic");
  });

  it.each([
    ["about", "about/warm-cache/route.ts"],
    ["homepage", "homepage/warm-cache/route.ts"],
    ["pages", "pages/warm-cache/route.ts"],
    ["static-pages", "static-pages/warm-cache/route.ts"],
    ["warm-pages", "warm-pages/route.ts"],
  ])("%s authorizes through isCacheWarmAuthorized and reads no secret itself", (_name, file) => {
    const source = readFileSync(join(__dirname, "..", file), "utf8");
    expect(source).toMatch(/if \(!isCacheWarmAuthorized\(request\)\) \{/);
    expect(source).not.toMatch(/process\.env\.(CACHE_WARM_SECRET|CRON_SECRET|REVALIDATION_SECRET)/);
    expect(source).not.toMatch(/searchParams\.get\("secret"\)/);
  });
});
