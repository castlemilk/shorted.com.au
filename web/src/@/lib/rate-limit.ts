import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "~/server/auth";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis as UpstashRedis } from "@upstash/redis";
import IORedis from "ioredis";
import { getUpstashRedisRestConfig } from "./redis-env";

export interface RateLimitConfig {
  /** Optional namespace so equal limits on different products do not share counters. */
  bucketName?: string;
  /** Requests allowed per window for unauthenticated users */
  anonymousLimit: number;
  /** Tokens refilled per window for unauthenticated burst buckets */
  anonymousRefillLimit?: number;
  /** Maximum burst tokens for unauthenticated users */
  anonymousBurstMaxTokens?: number;
  /** Requests allowed per window for authenticated users */
  authenticatedLimit: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Allow this bucket to pass when distributed Redis is unavailable */
  failOpenWithoutStore?: boolean;
}

interface RateLimitEnv {
  [key: string]: string | undefined;
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  REDIS_URL?: string;
  RATE_LIMIT_FAIL_OPEN?: string;
  RATE_LIMIT_REQUIRE_DISTRIBUTED?: string;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  anonymousLimit: 50,
  authenticatedLimit: 500,
  windowSeconds: 60, // 1 minute
};

export const BROWSER_READ_RATE_LIMIT: RateLimitConfig = {
  anonymousLimit: 600,
  anonymousRefillLimit: 600,
  anonymousBurstMaxTokens: 3000,
  authenticatedLimit: 3000,
  windowSeconds: 60,
  failOpenWithoutStore: true,
};

type RateLimitStore =
  | { kind: "upstash"; client: UpstashRedis }
  | { kind: "redis-url"; client: IORedis };

interface RateLimitOutcome {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

// Initialize Redis clients for rate limiting.
let upstashRedis: UpstashRedis | null = null;
let upstashRedisConfigKey = "";
let redisUrlClient: IORedis | null = null;
let redisUrlConfigKey = "";
const limiterPairs = new Map<
  string,
  {
    anonymous: Ratelimit;
    authenticated: Ratelimit;
  }
>();
let warnedMissingRedis = false;
let warnedFallback = false;

/**
 * Rate limiter that applies different limits based on authentication status
 * Uses Vercel KV (Upstash Redis) for distributed rate limiting
 *
 * Usage in API routes:
 * ```typescript
 * const rateLimitResult = await rateLimit(request, {
 *   anonymousLimit: 50,    // 50 requests per minute for anonymous users
 *   authenticatedLimit: 500 // 500 requests per minute for logged-in users
 * });
 * if (!rateLimitResult.success) {
 *   return rateLimitResult.response;
 * }
 * ```
 */
export async function rateLimit(
  request: NextRequest,
  config: Partial<RateLimitConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  success: boolean;
  response?: NextResponse;
  /**
   * Caller tier, present on a denial so the route can attribute the
   * `rate_limited` product_event without a second `auth()` round-trip.
   * Values match the product_event tier vocabulary.
   */
  tier?: "anonymous" | "authenticated";
}> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  // Check if user is authenticated
  const session = await auth();
  const isAuthenticated = !!session?.user?.id;

  // Get identifier (user ID for authenticated, IP for anonymous)
  const identifier = isAuthenticated
    ? `user:${session.user.id}`
    : `ip:${getClientIp(request)}`;

  const store = getRateLimitStore(env);

  // Use distributed Redis if configured, otherwise fallback to fail-open/fail-closed behavior.
  if (store) {
    try {
      const result =
        store.kind === "upstash"
          ? await limitWithUpstash(
              store.client,
              identifier,
              isAuthenticated,
              finalConfig,
            )
          : await limitWithRedisUrl(
              store.client,
              identifier,
              isAuthenticated,
              finalConfig,
            );

      if (!result.success) {
        return {
          ...buildRateLimitExceededResponse(result, isAuthenticated),
          tier: isAuthenticated ? "authenticated" : "anonymous",
        };
      }

      // Return success - headers will be set by the caller if needed
      return { success: true };
    } catch (error) {
      console.error("Distributed rate limiting error:", error);
      if (
        shouldFailClosedWithoutRedis(env) &&
        !finalConfig.failOpenWithoutStore
      ) {
        return buildRateLimitUnavailableResponse();
      }
      return { success: true };
    }
  }

  // Fallback: In-memory rate limiting (development only)
  if (
    shouldFailClosedWithoutRedis(env) &&
    !finalConfig.failOpenWithoutStore
  ) {
    warnMissingRedisOnce();
    console.error(
      "Distributed rate limiting is required in production. Configure Vercel KV or set RATE_LIMIT_FAIL_OPEN=true intentionally.",
    );
    return buildRateLimitUnavailableResponse();
  }

  if (!finalConfig.failOpenWithoutStore) {
    warnMissingRedisOnce();
    warnFallbackOnce();
  }
  return { success: true };
}

/**
 * Extract client IP from request
 */
function getClientIp(request: NextRequest): string {
  // Try various headers that might contain the real IP
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  // Fallback to a generic identifier
  return "unknown";
}

function getRateLimitStore(env: NodeJS.ProcessEnv): RateLimitStore | null {
  const upstashClient = getUpstashRedis(env);
  if (upstashClient) {
    return { kind: "upstash", client: upstashClient };
  }

  const redisUrlClient = getRedisUrlClient(env);
  if (redisUrlClient) {
    return { kind: "redis-url", client: redisUrlClient };
  }

  return null;
}

function getUpstashRedis(env: NodeJS.ProcessEnv): UpstashRedis | null {
  const redisConfig = getUpstashRedisRestConfig(env);
  if (!redisConfig) {
    return null;
  }

  const nextConfigKey = `${redisConfig.source}:${redisConfig.url}:${redisConfig.token}`;
  if (upstashRedis && upstashRedisConfigKey === nextConfigKey) {
    return upstashRedis;
  }

  upstashRedis = new UpstashRedis({
    url: redisConfig.url,
    token: redisConfig.token,
  });
  upstashRedisConfigKey = nextConfigKey;
  limiterPairs.clear();
  return upstashRedis;
}

function getRedisUrlClient(env: NodeJS.ProcessEnv): IORedis | null {
  const redisUrl = normalizeRedisUrl(env.REDIS_URL);
  if (!redisUrl) {
    return null;
  }

  if (redisUrlClient && redisUrlConfigKey === redisUrl) {
    return redisUrlClient;
  }

  redisUrlClient = new IORedis(redisUrl, {
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => {
      if (times > 2) return null;
      return Math.min(times * 100, 1000);
    },
    enableReadyCheck: false,
    lazyConnect: true,
  });
  redisUrlClient.on("error", (error) => {
    console.error("Redis rate-limit connection error:", error.message);
  });
  redisUrlConfigKey = redisUrl;
  return redisUrlClient;
}

function normalizeRedisUrl(value: string | undefined): string | undefined {
  const redisUrl = value?.trim();
  if (!redisUrl) return undefined;

  try {
    const parsed = new URL(redisUrl);
    if (
      (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") ||
      !parsed.hostname ||
      !parsed.password
    ) {
      return undefined;
    }
    return redisUrl;
  } catch {
    return undefined;
  }
}

async function limitWithUpstash(
  redisClient: UpstashRedis,
  identifier: string,
  isAuthenticated: boolean,
  config: RateLimitConfig,
): Promise<RateLimitOutcome> {
  const limiterPair = getLimiterPair(redisClient, config);
  const limiter = isAuthenticated
    ? limiterPair.authenticated
    : limiterPair.anonymous;
  const result = await limiter.limit(identifier);
  const limit = isAuthenticated
    ? config.authenticatedLimit
    : (config.anonymousBurstMaxTokens ?? config.anonymousLimit);

  return {
    success: result.success,
    limit,
    remaining: result.remaining,
    reset: result.reset,
  };
}

function getLimiterPair(redisClient: UpstashRedis, config: RateLimitConfig) {
  const anonymousRefillLimit =
    config.anonymousRefillLimit ?? config.anonymousLimit;
  const key = [
    bucketPrefix(config),
    config.anonymousLimit,
    anonymousRefillLimit,
    config.anonymousBurstMaxTokens ?? "window",
    config.authenticatedLimit,
    config.windowSeconds,
  ].join(":");
  const existing = limiterPairs.get(key);
  if (existing) {
    return existing;
  }

  const anonymousLimiter = config.anonymousBurstMaxTokens
    ? new Ratelimit({
        redis: redisClient,
        limiter: Ratelimit.tokenBucket(
          anonymousRefillLimit,
          `${config.windowSeconds} s`,
          config.anonymousBurstMaxTokens,
        ),
        // analytics adds an extra Redis command per request — a material share of
        // the 2026-08 quota burn. Off; the ephemeral cache below short-circuits
        // repeat offenders without any Redis round-trip.
        analytics: false,
        ephemeralCache: new Map(),
        prefix: `${bucketPrefix(config)}:anon:burst:${anonymousRefillLimit}:${config.windowSeconds}:${config.anonymousBurstMaxTokens}`,
      })
    : new Ratelimit({
        redis: redisClient,
        limiter: Ratelimit.slidingWindow(
          config.anonymousLimit,
          `${config.windowSeconds} s`,
        ),
        // analytics adds an extra Redis command per request — a material share of
        // the 2026-08 quota burn. Off; the ephemeral cache below short-circuits
        // repeat offenders without any Redis round-trip.
        analytics: false,
        ephemeralCache: new Map(),
        prefix: `${bucketPrefix(config)}:anon:${config.anonymousLimit}:${config.windowSeconds}`,
      });

  const pair = {
    anonymous: anonymousLimiter,
    authenticated: new Ratelimit({
      redis: redisClient,
      limiter: Ratelimit.slidingWindow(
        config.authenticatedLimit,
        `${config.windowSeconds} s`,
      ),
      // analytics adds an extra Redis command per request — a material share of
      // the 2026-08 quota burn. Off; the ephemeral cache below short-circuits
      // repeat offenders without any Redis round-trip.
      analytics: false,
      ephemeralCache: new Map(),
      prefix: `${bucketPrefix(config)}:auth:${config.authenticatedLimit}:${config.windowSeconds}`,
    }),
  };

  limiterPairs.set(key, pair);
  return pair;
}

async function limitWithRedisUrl(
  redisClient: IORedis,
  identifier: string,
  isAuthenticated: boolean,
  config: RateLimitConfig,
): Promise<RateLimitOutcome> {
  if (!isAuthenticated && config.anonymousBurstMaxTokens) {
    return limitWithRedisTokenBucket(redisClient, identifier, config);
  }

  const limit = isAuthenticated
    ? config.authenticatedLimit
    : config.anonymousLimit;
  const keyPrefix = isAuthenticated
    ? `${bucketPrefix(config)}:auth:${config.authenticatedLimit}:${config.windowSeconds}`
    : `${bucketPrefix(config)}:anon:${config.anonymousLimit}:${config.windowSeconds}`;
  const key = `${keyPrefix}:${identifier}`;
  const current = await redisClient.incr(key);
  if (current === 1) {
    await redisClient.expire(key, config.windowSeconds);
  }
  const ttl = await redisClient.ttl(key);
  const reset = Date.now() + (ttl > 0 ? ttl : config.windowSeconds) * 1000;

  return {
    success: current <= limit,
    limit,
    remaining: Math.max(0, limit - current),
    reset,
  };
}

const REDIS_TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local interval = tonumber(ARGV[3])
local max_tokens = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local bucket = redis.call("HMGET", key, "tokens", "updated")
local tokens = tonumber(bucket[1]) or max_tokens
local updated = tonumber(bucket[2]) or now
local elapsed = math.max(0, now - updated)
tokens = math.min(max_tokens, tokens + (elapsed * refill / interval))

local success = 0
if tokens >= 1 then
  tokens = tokens - 1
  success = 1
end

redis.call("HSET", key, "tokens", tokens, "updated", now)
redis.call("PEXPIRE", key, ttl)

local retry_ms = 0
if success == 0 and refill > 0 then
  retry_ms = math.ceil((1 - tokens) * interval / refill)
end

return { success, math.floor(tokens), now + retry_ms }
`;

async function limitWithRedisTokenBucket(
  redisClient: IORedis,
  identifier: string,
  config: RateLimitConfig,
): Promise<RateLimitOutcome> {
  const refillLimit = config.anonymousRefillLimit ?? config.anonymousLimit;
  const maxTokens = config.anonymousBurstMaxTokens ?? config.anonymousLimit;
  const windowMs = config.windowSeconds * 1000;
  const fullRefillWindows = Math.max(1, Math.ceil(maxTokens / refillLimit));
  const ttlMs = fullRefillWindows * windowMs * 2;
  const now = Date.now();
  const key = [
    `${bucketPrefix(config)}:anon:burst:${refillLimit}:${config.windowSeconds}:${maxTokens}`,
    identifier,
  ].join(":");
  const result = await redisClient.eval(
    REDIS_TOKEN_BUCKET_SCRIPT,
    1,
    key,
    now,
    refillLimit,
    windowMs,
    maxTokens,
    ttlMs,
  );
  const [successValue, remainingValue, resetValue] = Array.isArray(result)
    ? result.map(Number)
    : [0, 0, now + windowMs];

  return {
    success: successValue === 1,
    limit: maxTokens,
    remaining: Math.max(0, remainingValue ?? 0),
    reset: resetValue ?? now + windowMs,
  };
}

function buildRateLimitExceededResponse(
  result: RateLimitOutcome,
  isAuthenticated: boolean,
): { success: false; response: NextResponse } {
  const resetInSeconds = Math.max(
    1,
    Math.ceil((result.reset - Date.now()) / 1000),
  );

  return {
    success: false,
    response: NextResponse.json(
      {
        error: "Rate limit exceeded",
        message: isAuthenticated
          ? `You have exceeded the rate limit. Please try again in ${resetInSeconds} seconds.`
          : `Rate limit exceeded. Sign in for higher limits, or try again in ${resetInSeconds} seconds.`,
        retryAfter: resetInSeconds,
        limit: result.limit,
        authenticated: isAuthenticated,
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": result.limit.toString(),
          "X-RateLimit-Remaining": result.remaining.toString(),
          "X-RateLimit-Reset": result.reset.toString(),
          "Retry-After": resetInSeconds.toString(),
        },
      },
    ),
  };
}

function buildRateLimitUnavailableResponse(): {
  success: false;
  response: NextResponse;
} {
  return {
    success: false,
    response: NextResponse.json(
      {
        error: "Rate limiting unavailable",
        message: "Please try again shortly.",
      },
      {
        status: 503,
        headers: {
          "Retry-After": "60",
        },
      },
    ),
  };
}

function bucketPrefix(config: RateLimitConfig): string {
  const bucketName = config.bucketName?.trim();
  if (!bucketName) {
    return "ratelimit:api";
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(bucketName)) {
    return "ratelimit:api";
  }
  return `ratelimit:api:${bucketName}`;
}

function shouldFailClosedWithoutRedis(env: NodeJS.ProcessEnv): boolean {
  return shouldFailClosedWithoutDistributedRateLimit(env);
}

export function shouldFailClosedWithoutDistributedRateLimit(
  env: RateLimitEnv,
): boolean {
  return (
    (isProductionEnvironment(env) ||
      env.RATE_LIMIT_REQUIRE_DISTRIBUTED === "true") &&
    env.RATE_LIMIT_FAIL_OPEN !== "true"
  );
}

function isProductionEnvironment(env: RateLimitEnv): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

function warnMissingRedisOnce(): void {
  if (warnedMissingRedis) return;
  warnedMissingRedis = true;
  console.warn(
    "⚠️  Vercel KV not configured. Distributed rate limiting is unavailable.",
  );
}

function warnFallbackOnce(): void {
  if (warnedFallback) return;
  warnedFallback = true;
  console.warn(
    "Using rate-limit fallback. Configure Vercel KV for strict production API limits.",
  );
}
