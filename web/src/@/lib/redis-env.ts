export interface RedisRestConfig {
  url: string;
  token: string;
  source: "kv-rest" | "upstash-rest" | "redis-url";
}

export interface RedisRestEnv {
  [key: string]: string | undefined;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  REDIS_URL?: string;
}

export function getUpstashRedisRestConfig(
  env: RedisRestEnv,
): RedisRestConfig | null {
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
