export interface RedisRestConfig {
  url: string;
  token: string;
  source: "rate-limit-dedicated" | "kv-rest" | "upstash-rest" | "redis-url";
}

export interface RedisRestEnv {
  [key: string]: string | undefined;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  RATE_LIMIT_UPSTASH_REDIS_REST_URL?: string;
  RATE_LIMIT_UPSTASH_REDIS_REST_TOKEN?: string;
  REDIS_URL?: string;
}

export function getUpstashRedisRestConfig(
  env: RedisRestEnv,
): RedisRestConfig | null {
  // Dedicated rate-limit quota DB, first priority. This resolver is consumed
  // ONLY by the limiter surfaces (middleware.ts, rate-limit.ts) — the page
  // cache resolves its Redis separately — so setting these two vars moves
  // rate limiting onto its own database without touching the cache. Mirrors
  // the Go API layer's RATE_LIMIT_UPSTASH_REDIS_REST_* split after the
  // 2026-08 shared-quota incident (limiter burned the cap; cache froze).
  const rlUrl = normalizeEnvValue(env.RATE_LIMIT_UPSTASH_REDIS_REST_URL);
  const rlToken = normalizeEnvValue(env.RATE_LIMIT_UPSTASH_REDIS_REST_TOKEN);
  if (rlUrl && rlToken) {
    return {
      url: trimTrailingSlash(rlUrl),
      token: rlToken,
      source: "rate-limit-dedicated",
    };
  }

  const kvUrl = normalizeEnvValue(env.KV_REST_API_URL);
  const kvToken = normalizeEnvValue(env.KV_REST_API_TOKEN);
  if (kvUrl && kvToken) {
    return {
      url: trimTrailingSlash(kvUrl),
      token: kvToken,
      source: "kv-rest",
    };
  }

  const upstashUrl = normalizeEnvValue(env.UPSTASH_REDIS_REST_URL);
  const upstashToken = normalizeEnvValue(env.UPSTASH_REDIS_REST_TOKEN);
  if (upstashUrl && upstashToken) {
    return {
      url: trimTrailingSlash(upstashUrl),
      token: upstashToken,
      source: "upstash-rest",
    };
  }

  return parseRedisUrlForRest(env.REDIS_URL);
}

export function parseRedisUrlForRest(
  redisUrl: string | undefined,
): RedisRestConfig | null {
  const value = normalizeEnvValue(redisUrl);
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      return null;
    }

    const token = decodeURIComponent(parsed.password);
    if (!parsed.hostname || !token || !isRestCompatibleRedisHost(parsed.hostname)) {
      return null;
    }

    return {
      url: `${parsed.protocol === "rediss:" ? "https" : "http"}://${parsed.hostname}`,
      token,
      source: "redis-url",
    };
  } catch {
    return null;
  }
}

function isRestCompatibleRedisHost(hostname: string): boolean {
  return hostname.endsWith(".upstash.io") || hostname.endsWith(".vercel-storage.com");
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
