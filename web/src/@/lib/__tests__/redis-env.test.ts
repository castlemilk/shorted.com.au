import {
  getUpstashRedisRestConfig,
  parseRedisUrlForRest,
} from "../redis-env";

describe("redis-env", () => {
  it("prefers explicit Vercel KV REST env vars", () => {
    expect(
      getUpstashRedisRestConfig({
        KV_REST_API_URL: "https://kv.example/",
        KV_REST_API_TOKEN: "kv-token",
        UPSTASH_REDIS_REST_URL: "https://upstash.example",
        UPSTASH_REDIS_REST_TOKEN: "upstash-token",
        REDIS_URL: "rediss://default:redis-token@redis.example:6379",
      }),
    ).toEqual({
      url: "https://kv.example",
      token: "kv-token",
      source: "kv-rest",
    });
  });

  it("uses Upstash REST env vars when Vercel KV aliases are absent", () => {
    expect(
      getUpstashRedisRestConfig({
        UPSTASH_REDIS_REST_URL: "https://upstash.example/",
        UPSTASH_REDIS_REST_TOKEN: "upstash-token",
      }),
    ).toEqual({
      url: "https://upstash.example",
      token: "upstash-token",
      source: "upstash-rest",
    });
  });

  it("derives Upstash REST config from REDIS_URL", () => {
    expect(
      parseRedisUrlForRest(
        "rediss://default:secret%2Ftoken@settled-redfish-12345.upstash.io:6379",
      ),
    ).toEqual({
      url: "https://settled-redfish-12345.upstash.io",
      token: "secret/token",
      source: "redis-url",
    });
  });

  it("returns null when no REST-compatible Redis config exists", () => {
    expect(getUpstashRedisRestConfig({})).toBeNull();
    expect(parseRedisUrlForRest("not-a-url")).toBeNull();
    expect(parseRedisUrlForRest("redis://localhost:6379")).toBeNull();
    expect(
      parseRedisUrlForRest(
        "redis://default:secret@redis-11815.c291.ap-southeast-2-1.ec2.cloud.redislabs.com:11815",
      ),
    ).toBeNull();
  });
});
