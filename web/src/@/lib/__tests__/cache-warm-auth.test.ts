import { type NextRequest } from "next/server";
import { isCacheWarmAuthorized } from "../cache-warm-auth";

const WARM_ENV = [
  "CACHE_WARM_SECRET",
  "CRON_SECRET",
  "REVALIDATION_SECRET",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_REGION",
] as const;

/** The helper reads headers only. The URL is here to show that its query string is ignored. */
function request(headers: Record<string, string> = {}, search = ""): Pick<NextRequest, "headers"> {
  const nextUrl = new URL(`http://localhost/api/warm-cache${search}`);
  return { headers: new Headers(headers), nextUrl } as Pick<NextRequest, "headers">;
}

function configureAll() {
  process.env.CACHE_WARM_SECRET = "warm-secret";
  process.env.CRON_SECRET = "cron-secret";
  process.env.REVALIDATION_SECRET = "reval-secret";
}

describe("isCacheWarmAuthorized", () => {
  const saved: Partial<Record<(typeof WARM_ENV)[number], string>> = {};

  beforeEach(() => {
    for (const key of WARM_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of WARM_ENV) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("accepts each of the three credentials", () => {
    configureAll();
    expect(isCacheWarmAuthorized(request({ Authorization: "Bearer cron-secret" }))).toBe(true);
    expect(isCacheWarmAuthorized(request({ Authorization: "Bearer reval-secret" }))).toBe(true);
    expect(isCacheWarmAuthorized(request({ "X-Cache-Warm-Secret": "warm-secret" }))).toBe(true);
  });

  it.each<[string, Record<string, string>]>([
    ["no credential", {}],
    ["a wrong bearer", { Authorization: "Bearer wrong" }],
    ["a bearer that is a prefix of the secret", { Authorization: "Bearer cron" }],
    ["a wrong warm header", { "X-Cache-Warm-Secret": "wrong" }],
    ["the warm secret as a bearer", { Authorization: "Bearer warm-secret" }],
    ["the cron secret as the warm header", { "X-Cache-Warm-Secret": "cron-secret" }],
    ["the right secret under Basic", { Authorization: "Basic cron-secret" }],
    ["the right secret with no scheme", { Authorization: "cron-secret" }],
    ["the right secret under a lower-case scheme", { Authorization: "bearer cron-secret" }],
  ])("refuses %s", (_kind, headers) => {
    configureAll();
    expect(isCacheWarmAuthorized(request(headers))).toBe(false);
  });

  it("never reads a secret from the query string, even a correct one", () => {
    configureAll();
    expect(isCacheWarmAuthorized(request({}, "?secret=warm-secret"))).toBe(false);
    expect(isCacheWarmAuthorized(request({}, "?secret=cron-secret"))).toBe(false);
    expect(isCacheWarmAuthorized(request({}, "?secret=reval-secret"))).toBe(false);
  });

  it("answers everyone off Vercel when no credential is configured", () => {
    expect(isCacheWarmAuthorized(request())).toBe(true);
    expect(isCacheWarmAuthorized(request({ Authorization: "Bearer anything" }))).toBe(true);
  });

  it("refuses everyone on Vercel when no credential is configured", () => {
    process.env.VERCEL = "1";
    expect(isCacheWarmAuthorized(request())).toBe(false);
    expect(isCacheWarmAuthorized(request({ Authorization: "Bearer anything" }))).toBe(false);
  });

  it("refuses on Vercel when every secret is blank, with no header or an empty bearer", () => {
    process.env.VERCEL = "1";
    process.env.CACHE_WARM_SECRET = "";
    process.env.CRON_SECRET = "";
    process.env.REVALIDATION_SECRET = "";
    expect(isCacheWarmAuthorized(request())).toBe(false);
    expect(isCacheWarmAuthorized(request({ Authorization: "Bearer " }))).toBe(false);
  });

  it("answers everyone off Vercel when every secret is blank", () => {
    process.env.CACHE_WARM_SECRET = "";
    process.env.CRON_SECRET = "";
    process.env.REVALIDATION_SECRET = "";
    expect(isCacheWarmAuthorized(request())).toBe(true);
    expect(isCacheWarmAuthorized(request({ Authorization: "Bearer " }))).toBe(true);
  });

  it.each<[string, string]>([
    ["VERCEL_ENV", "preview"],
    ["VERCEL_REGION", "syd1"],
  ])("counts %s alone as a Vercel deployment", (name, value) => {
    process.env[name] = value;
    expect(isCacheWarmAuthorized(request())).toBe(false);
    expect(isCacheWarmAuthorized(request({ Authorization: "Bearer anything" }))).toBe(false);
  });

  it("does not count a blank Vercel variable", () => {
    process.env.VERCEL_ENV = "";
    process.env.VERCEL_REGION = "   ";
    expect(isCacheWarmAuthorized(request())).toBe(true);
  });

  it("treats an empty-string variable as unset", () => {
    process.env.VERCEL = "";
    expect(isCacheWarmAuthorized(request())).toBe(true);

    process.env.CRON_SECRET = "";
    process.env.CACHE_WARM_SECRET = "warm-secret";
    expect(isCacheWarmAuthorized(request({ Authorization: "Bearer " }))).toBe(false);
    expect(isCacheWarmAuthorized(request({ "X-Cache-Warm-Secret": "warm-secret" }))).toBe(true);
  });

  it("treats a blank variable as unset, and trims a stored secret", () => {
    process.env.CRON_SECRET = "   ";
    expect(isCacheWarmAuthorized(request())).toBe(true);

    process.env.CRON_SECRET = "cron-secret\n";
    process.env.CACHE_WARM_SECRET = "warm-secret";
    expect(isCacheWarmAuthorized(request({ Authorization: "Bearer cron-secret" }))).toBe(true);
  });
});
