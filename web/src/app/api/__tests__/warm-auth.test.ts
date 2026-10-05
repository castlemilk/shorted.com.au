import { type NextRequest } from "next/server";
import { GET as aboutWarm } from "../about/warm-cache/route";
import { GET as homepageWarm } from "../homepage/warm-cache/route";
import { GET as pagesWarm } from "../pages/warm-cache/route";

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

function request(query = "", headers = new Headers()): NextRequest {
  const nextUrl = new URL(`http://localhost/api/warm-cache${query}`);
  return { nextUrl, url: nextUrl.toString(), headers } as NextRequest;
}

describe.each([
  ["about", aboutWarm], ["homepage", homepageWarm], ["pages", pagesWarm],
] as const)("%s warm authentication", (_name, warm) => {
  const oldWarm = process.env.CACHE_WARM_SECRET;
  const oldCron = process.env.CRON_SECRET;
  const oldFetch = global.fetch;
  beforeEach(() => {
    process.env.CACHE_WARM_SECRET = "test-warm-secret";
    process.env.CRON_SECRET = "test-cron-secret";
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  });
  afterEach(() => {
    if (oldWarm === undefined) delete process.env.CACHE_WARM_SECRET;
    else process.env.CACHE_WARM_SECRET = oldWarm;
    if (oldCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = oldCron;
    global.fetch = oldFetch;
  });

  it.each([
    ["legacy query", "?secret=test-warm-secret", {}],
    ["warm header", "", { "X-Cache-Warm-Secret": "test-warm-secret" }],
    ["Vercel cron", "", { Authorization: "Bearer test-cron-secret" }],
  ])("accepts %s credentials", async (_kind, query, headers) => {
    expect((await warm(request(query as string, new Headers(headers)))).status).toBe(200);
  });

  it("rejects missing or invalid credentials before warming", async () => {
    expect((await warm(request())).status).toBe(401);
    expect((await warm(request("", new Headers({ Authorization: "Bearer invalid" })))).status).toBe(401);
    // A supplied warm header takes precedence over a legacy query credential.
    expect((await warm(request("?secret=test-warm-secret", new Headers({ "X-Cache-Warm-Secret": "invalid" })))).status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("retains the existing behavior when no optional warm secret is configured", async () => {
    delete process.env.CACHE_WARM_SECRET;
    expect((await warm(request())).status).toBe(200);
  });
});
