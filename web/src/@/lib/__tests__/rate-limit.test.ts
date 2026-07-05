import { NextRequest } from "next/server";
import { auth } from "~/server/auth";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import IORedis from "ioredis";

const mockIoRedisClient = {
  on: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn(),
  eval: jest.fn(),
};

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("@upstash/redis", () => ({
  Redis: jest.fn(),
}));

jest.mock("ioredis", () => ({
  __esModule: true,
  default: jest.fn(() => mockIoRedisClient),
}));

jest.mock("@upstash/ratelimit", () => ({
  Ratelimit: Object.assign(
    jest.fn().mockImplementation(() => ({
      limit: jest.fn().mockResolvedValue({
        success: true,
        limit: 1,
        remaining: 1,
        reset: Date.now() + 60_000,
      }),
    })),
    {
      slidingWindow: jest.fn((limit: number, window: string) => ({
        limit,
        window,
      })),
      tokenBucket: jest.fn(
        (refillRate: number, interval: string, maxTokens: number) => ({
          refillRate,
          interval,
          maxTokens,
        }),
      ),
    },
  ),
}));

describe("rate-limit production safety", () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalKvUrl = process.env.KV_REST_API_URL;
  const originalKvToken = process.env.KV_REST_API_TOKEN;
  const originalUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalFailOpen = process.env.RATE_LIMIT_FAIL_OPEN;
  const originalRequireDistributed = process.env.RATE_LIMIT_REQUIRE_DISTRIBUTED;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "production";
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.REDIS_URL;
    delete process.env.RATE_LIMIT_FAIL_OPEN;
    process.env.RATE_LIMIT_REQUIRE_DISTRIBUTED = "true";
    (auth as jest.Mock).mockResolvedValue(null);
    mockIoRedisClient.on.mockReturnValue(mockIoRedisClient);
    mockIoRedisClient.incr.mockResolvedValue(1);
    mockIoRedisClient.expire.mockResolvedValue(1);
    mockIoRedisClient.ttl.mockResolvedValue(60);
    mockIoRedisClient.eval.mockResolvedValue([1, 2999, Date.now() + 60_000]);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }
    process.env.NODE_ENV = originalNodeEnv;
    if (originalKvUrl === undefined) {
      delete process.env.KV_REST_API_URL;
    } else {
      process.env.KV_REST_API_URL = originalKvUrl;
    }
    if (originalKvToken === undefined) {
      delete process.env.KV_REST_API_TOKEN;
    } else {
      process.env.KV_REST_API_TOKEN = originalKvToken;
    }
    if (originalUpstashUrl === undefined) {
      delete process.env.UPSTASH_REDIS_REST_URL;
    } else {
      process.env.UPSTASH_REDIS_REST_URL = originalUpstashUrl;
    }
    if (originalUpstashToken === undefined) {
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    } else {
      process.env.UPSTASH_REDIS_REST_TOKEN = originalUpstashToken;
    }
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
    if (originalFailOpen === undefined) {
      delete process.env.RATE_LIMIT_FAIL_OPEN;
    } else {
      process.env.RATE_LIMIT_FAIL_OPEN = originalFailOpen;
    }
    if (originalRequireDistributed === undefined) {
      delete process.env.RATE_LIMIT_REQUIRE_DISTRIBUTED;
    } else {
      process.env.RATE_LIMIT_REQUIRE_DISTRIBUTED = originalRequireDistributed;
    }
  });

  it("fails closed in production when distributed rate limiting is not configured", async () => {
    const { rateLimit } =
      jest.requireActual<typeof import("../rate-limit")>("../rate-limit");

    const result = await rateLimit(
      new NextRequest("https://shorted.com.au/api/search/stocks?q=BHP"),
      {
        anonymousLimit: 10,
        authenticatedLimit: 100,
        windowSeconds: 60,
      },
      {
        RATE_LIMIT_REQUIRE_DISTRIBUTED: "true",
      } as NodeJS.ProcessEnv,
    );

    expect(result.success).toBe(false);
    expect(result.response?.status).toBe(503);
  });

  it("exports generous browser read limits for frontend data endpoints", () => {
    const { BROWSER_READ_RATE_LIMIT } =
      jest.requireActual<typeof import("../rate-limit")>("../rate-limit");

    expect(BROWSER_READ_RATE_LIMIT.anonymousLimit).toBeGreaterThanOrEqual(600);
    expect(BROWSER_READ_RATE_LIMIT.authenticatedLimit).toBeGreaterThanOrEqual(
      3000,
    );
    expect(BROWSER_READ_RATE_LIMIT.windowSeconds).toBe(60);
    expect(
      (BROWSER_READ_RATE_LIMIT as { anonymousBurstMaxTokens?: number })
        .anonymousBurstMaxTokens,
    ).toBe(3000);
    expect(
      (BROWSER_READ_RATE_LIMIT as { anonymousRefillLimit?: number })
        .anonymousRefillLimit,
    ).toBe(BROWSER_READ_RATE_LIMIT.anonymousLimit);
    expect(BROWSER_READ_RATE_LIMIT.failOpenWithoutStore).toBe(true);
  });

  it("does not warn about missing Vercel KV at module import time", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    jest.isolateModules(() => {
      jest.requireActual<typeof import("../rate-limit")>("../rate-limit");
    });

    expect(warnSpy).not.toHaveBeenCalledWith(
      "⚠️  Vercel KV not configured. Distributed rate limiting is unavailable.",
    );
  });

  it("fails open for browser read buckets when distributed rate limiting is unavailable", async () => {
    const { BROWSER_READ_RATE_LIMIT, rateLimit } =
      jest.requireActual<typeof import("../rate-limit")>("../rate-limit");

    const result = await rateLimit(
      new NextRequest("https://shorted.com.au/api/market-data/historical"),
      BROWSER_READ_RATE_LIMIT,
      {
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        RATE_LIMIT_REQUIRE_DISTRIBUTED: "true",
      } as NodeJS.ProcessEnv,
    );

    expect(result.success).toBe(true);
    expect(result.response).toBeUndefined();
  });

  it("uses token bucket burst limiting for browser read anonymous traffic", async () => {
    const { BROWSER_READ_RATE_LIMIT, rateLimit } =
      jest.requireActual<typeof import("../rate-limit")>("../rate-limit");

    await rateLimit(
      new NextRequest("https://shorted.com.au/api/search/stocks?q=BHP"),
      BROWSER_READ_RATE_LIMIT,
      {
        KV_REST_API_URL: "https://redis.example",
        KV_REST_API_TOKEN: "token",
      } as NodeJS.ProcessEnv,
    );

    expect(Ratelimit.tokenBucket).toHaveBeenCalledWith(600, "60 s", 3000);
    const prefixes = (Ratelimit as jest.Mock).mock.calls.map(
      ([config]) => config.prefix,
    );
    expect(prefixes).toContain("ratelimit:api:anon:burst:600:60:3000");
  });

  it("uses REDIS_URL as an Upstash REST-compatible distributed store", async () => {
    const { BROWSER_READ_RATE_LIMIT, rateLimit } =
      jest.requireActual<typeof import("../rate-limit")>("../rate-limit");

    await rateLimit(
      new NextRequest("https://shorted.com.au/api/search/stocks?q=BHP"),
      BROWSER_READ_RATE_LIMIT,
      {
        REDIS_URL:
          "rediss://default:secret%2Ftoken@settled-redfish-12345.upstash.io:6379",
      } as NodeJS.ProcessEnv,
    );

    expect(Redis).toHaveBeenCalledWith({
      url: "https://settled-redfish-12345.upstash.io",
      token: "secret/token",
    });
    expect(Ratelimit.tokenBucket).toHaveBeenCalledWith(600, "60 s", 3000);
  });

  it("uses Redis Labs REDIS_URL over TCP for strict API rate limits", async () => {
    const { rateLimit } =
      jest.requireActual<typeof import("../rate-limit")>("../rate-limit");

    const result = await rateLimit(
      new NextRequest("https://shorted.com.au/api/stripe/checkout"),
      {
        anonymousLimit: 2,
        authenticatedLimit: 12,
        windowSeconds: 60,
      },
      {
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        REDIS_URL:
          "redis://default:secret@redis-11815.c291.ap-southeast-2-1.ec2.cloud.redislabs.com:11815",
      } as NodeJS.ProcessEnv,
    );

    expect(result.success).toBe(true);
    expect(IORedis).toHaveBeenCalledWith(
      "redis://default:secret@redis-11815.c291.ap-southeast-2-1.ec2.cloud.redislabs.com:11815",
      expect.objectContaining({
        enableReadyCheck: false,
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      }),
    );
    expect(mockIoRedisClient.incr).toHaveBeenCalledWith(
      "ratelimit:api:anon:2:60:ip:unknown",
    );
    expect(mockIoRedisClient.expire).toHaveBeenCalledWith(
      "ratelimit:api:anon:2:60:ip:unknown",
      60,
    );
  });

  it("uses Redis Labs REDIS_URL token buckets for browser read bursts", async () => {
    const { BROWSER_READ_RATE_LIMIT, rateLimit } =
      jest.requireActual<typeof import("../rate-limit")>("../rate-limit");

    const result = await rateLimit(
      new NextRequest("https://shorted.com.au/api/market-data/historical"),
      BROWSER_READ_RATE_LIMIT,
      {
        REDIS_URL:
          "redis://default:secret2@redis-11816.c291.ap-southeast-2-1.ec2.cloud.redislabs.com:11816",
      } as NodeJS.ProcessEnv,
    );

    expect(result.success).toBe(true);
    expect(mockIoRedisClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("local key = KEYS[1]"),
      1,
      "ratelimit:api:anon:burst:600:60:3000:ip:unknown",
      expect.any(Number),
      600,
      60_000,
      3000,
      600_000,
    );
  });

  it("creates separate limiter buckets for different route limit configs", async () => {
    const { rateLimit } =
      jest.requireActual<typeof import("../rate-limit")>("../rate-limit");

    await rateLimit(
      new NextRequest("https://shorted.com.au/api/search/stocks?q=BHP"),
      { anonymousLimit: 600, authenticatedLimit: 3000, windowSeconds: 60 },
      {
        KV_REST_API_URL: "https://redis.example",
        KV_REST_API_TOKEN: "token",
      } as NodeJS.ProcessEnv,
    );
    await rateLimit(
      new NextRequest("https://shorted.com.au/api/stripe/checkout"),
      { anonymousLimit: 2, authenticatedLimit: 12, windowSeconds: 60 },
      {
        KV_REST_API_URL: "https://redis.example",
        KV_REST_API_TOKEN: "token",
      } as NodeJS.ProcessEnv,
    );

    const prefixes = (Ratelimit as jest.Mock).mock.calls.map(
      ([config]) => config.prefix,
    );
    expect(prefixes).toEqual(
      expect.arrayContaining([
        "ratelimit:api:anon:600:60",
        "ratelimit:api:auth:3000:60",
        "ratelimit:api:anon:2:60",
        "ratelimit:api:auth:12:60",
      ]),
    );
  });
});
