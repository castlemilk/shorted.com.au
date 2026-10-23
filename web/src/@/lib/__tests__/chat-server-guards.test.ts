import { NextRequest } from "next/server";
import { auth } from "~/server/auth";
import IORedis from "ioredis";
import {
  buildUpstreamHeaders,
  CHAT_LIMIT_HEADER,
  CHAT_MAX_MESSAGE_CHARS,
  chatErrorFromUpstreamError,
  chatErrorResponseFromUpstream,
  chatRateLimitConfigs,
  chatRateLimitMessage,
  enforceChatRateLimits,
  formatWait,
  parseChatLimitDetail,
} from "../chat-server-guards";
import { rateLimit } from "../rate-limit";

// src/test/setup.ts replaces the shared limiter with an always-allow stub for
// every test. This file tests the real limiter, so it takes the real module back.
jest.unmock("@/lib/rate-limit");

const mockRedis = {
  on: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn(),
  eval: jest.fn(),
};

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("ioredis", () => ({
  __esModule: true,
  default: jest.fn(() => mockRedis),
}));

const mockAuth = auth as jest.MockedFunction<typeof auth>;

function sendRequest(): NextRequest {
  return new NextRequest("https://shorted.com.au/api/chat", {
    method: "POST",
    headers: { origin: "https://shorted.com.au" },
  });
}

describe("chat-server-guards", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      RATE_LIMIT_REQUIRE_DISTRIBUTED: "true",
      RATE_LIMIT_FAIL_OPEN: undefined,
      REDIS_URL: "redis://:test-password@localhost:6379",
      CHAT_SENDS_PER_MINUTE: undefined,
    } as NodeJS.ProcessEnv;
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
      expires: "2099-01-01T00:00:00.000Z",
    } as never);
    mockRedis.on.mockReturnValue(mockRedis);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe("send and read buckets fail open", () => {
    it("admits a send when the Redis store throws, instead of refusing it with a 503", async () => {
      mockRedis.incr.mockRejectedValue(new Error("ECONNRESET"));

      await expect(
        enforceChatRateLimits(sendRequest(), "SendMessage"),
      ).resolves.toBeUndefined();
    });

    it("admits a read when the Redis store throws", async () => {
      mockRedis.incr.mockRejectedValue(new Error("ECONNRESET"));

      await expect(
        enforceChatRateLimits(sendRequest(), "ListConversations"),
      ).resolves.toBeUndefined();
    });

    it("admits a send when no store is configured, in production", async () => {
      delete process.env.REDIS_URL;

      await expect(
        enforceChatRateLimits(sendRequest(), "SendMessage"),
      ).resolves.toBeUndefined();
    });

    it("still refuses a non-chat bucket on the same throw, so the test exercises the real fail-closed path", async () => {
      mockRedis.incr.mockRejectedValue(new Error("ECONNRESET"));

      const result = await rateLimit(sendRequest(), {
        anonymousLimit: 0,
        authenticatedLimit: 5,
        windowSeconds: 60,
      });

      expect(result.success).toBe(false);
      expect(result.response?.status).toBe(503);
    });

    it("sets failOpenWithoutStore on every chat bucket", () => {
      for (const method of ["SendMessage", "ListConversations"]) {
        const configs = chatRateLimitConfigs(method, process.env);
        expect(configs.length).toBeGreaterThan(0);
        for (const config of configs) {
          expect(config.failOpenWithoutStore).toBe(true);
        }
      }
    });
  });

  describe("a refused send", () => {
    it("is answered in the chat contract, with the window and the wait", async () => {
      // The fourth send is allowed, the fifth is over the per-minute limit.
      mockRedis.incr.mockResolvedValue(5);
      mockRedis.ttl.mockResolvedValue(42);

      const response = await enforceChatRateLimits(
        sendRequest(),
        "SendMessage",
      );

      expect(response?.status).toBe(429);
      expect(response?.headers.get("Retry-After")).toBe("42");
      const body = await response?.json();
      expect(body).toMatchObject({
        error: "Rate limit exceeded",
        code: "rate_limited",
        limitKind: "per_minute",
        retryAfterSeconds: 42,
        message: "You can send 4 messages per minute. Try again in 42 seconds.",
      });
      expect(typeof body.resetAt).toBe("number");
    });

    it("keeps the shared limiter's own body out of the chat response", async () => {
      mockRedis.incr.mockResolvedValue(5);
      mockRedis.ttl.mockResolvedValue(42);

      const response = await enforceChatRateLimits(
        sendRequest(),
        "SendMessage",
      );

      expect(Object.keys((await response?.json()) ?? {}).sort()).toEqual(
        ["error", "code", "message", "retryAfterSeconds", "limitKind", "resetAt"].sort(),
      );
    });
  });

  describe("chatErrorFromUpstreamError", () => {
    function connectLike(
      code: number,
      message: string,
      metadata: Record<string, string> = {},
    ): unknown {
      return Object.assign(new Error(message), {
        code,
        metadata: new Headers(metadata),
      });
    }

    it("reads a ResourceExhausted limit from its metadata", () => {
      const body = chatErrorFromUpstreamError(
        connectLike(8, "limit", {
          [CHAT_LIMIT_HEADER]: JSON.stringify({
            kind: "per_minute",
            limit: 4,
            retry_after_seconds: 30,
            reset_at: 1_800_000_000,
          }),
        }),
      );

      expect(body).toEqual({
        error: "Rate limit exceeded",
        code: "rate_limited",
        message: "You can send 4 messages per minute. Try again in 30 seconds.",
        retryAfterSeconds: 30,
        limitKind: "per_minute",
        resetAt: 1_800_000_000,
      });
    });

    it("still answers rate_limited when the limit metadata is missing", () => {
      expect(chatErrorFromUpstreamError(connectLike(8, "limit"))).toMatchObject({
        code: "rate_limited",
        message: expect.any(String),
      });
      expect(
        chatErrorFromUpstreamError(connectLike(8, "limit")),
      ).not.toHaveProperty("limitKind");
    });

    it("maps an upstream Unauthenticated to unavailable, and logs it for the operator", () => {
      const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        expect(chatErrorFromUpstreamError(connectLike(16, "x"))).toMatchObject({
          code: "unavailable",
          message: "Chat is temporarily unavailable.",
        });
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("INTERNAL_SERVICE_SECRET"));
      } finally {
        consoleError.mockRestore();
      }
    });

    it.each([
      ["invalid_argument", 3],
      ["not_found", 5],
      ["permission_denied", 7],
      ["out_of_range", 11],
    ])("maps %s to invalid_request", (_, code) => {
      expect(chatErrorFromUpstreamError(connectLike(code, "x"))).toMatchObject({
        code: "invalid_request",
      });
    });

    it("says a conversation the service cannot find is no longer available, not a bad request", () => {
      expect(chatErrorFromUpstreamError(connectLike(5, "conversation not found"))).toEqual({
        error: "Conversation not found",
        code: "invalid_request",
        message: "This conversation is no longer available. Start a new chat.",
      });
      expect(chatErrorFromUpstreamError(connectLike(7, "conversation not found"))).toMatchObject({
        code: "invalid_request",
        message: "This conversation is no longer available. Start a new chat.",
      });
    });

    it.each([
      ["internal", 13],
      ["unavailable", 14],
      ["failed_precondition", 9],
    ])("maps %s to unavailable", (_, code) => {
      expect(chatErrorFromUpstreamError(connectLike(code, "x"))).toMatchObject({
        code: "unavailable",
        message: "Chat is temporarily unavailable.",
      });
    });

    it("answers an error it cannot name as unavailable", () => {
      expect(chatErrorFromUpstreamError(new Error("socket hang up"))).toMatchObject({
        code: "unavailable",
      });
      expect(chatErrorFromUpstreamError(undefined)).toMatchObject({
        code: "unavailable",
      });
    });

    it("never passes the upstream message to the client", () => {
      const body = chatErrorFromUpstreamError(
        connectLike(13, "panic: nil pointer at store.go:42"),
      );

      expect(JSON.stringify(body)).not.toContain("store.go");
    });
  });

  describe("chatErrorResponseFromUpstream", () => {
    it("maps a Connect invalid_argument to a 400 invalid_request", async () => {
      const response = await chatErrorResponseFromUpstream(
        new Response(JSON.stringify({ code: "invalid_argument", message: "x" }), {
          status: 400,
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_request",
      });
    });

    it("maps an unrecognised Connect code to unavailable, whatever its status", async () => {
      const response = await chatErrorResponseFromUpstream(
        new Response(JSON.stringify({ code: "internal", message: "x" }), {
          status: 500,
        }),
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "unavailable",
      });
    });

    it("answers a service-credential Unauthenticated as unavailable, never as a session end", async () => {
      const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const json = await chatErrorResponseFromUpstream(
          new Response(JSON.stringify({ code: "unauthenticated", message: "x" }), {
            status: 401,
          }),
        );
        expect(json.status).toBe(503);
        await expect(json.json()).resolves.toMatchObject({ code: "unavailable" });

        const plain = await chatErrorResponseFromUpstream(
          new Response("unauthorized", { status: 401 }),
        );
        expect(plain.status).toBe(503);
        await expect(plain.json()).resolves.toMatchObject({ code: "unavailable" });
        expect(consoleError).toHaveBeenCalledTimes(2);
      } finally {
        consoleError.mockRestore();
      }
    });

    it("falls back to the HTTP status when the body is plain text", async () => {
      const response = await chatErrorResponseFromUpstream(
        new Response("not found", { status: 404 }),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_request",
      });
    });
  });

  describe("parseChatLimitDetail", () => {
    it("reads a well-formed limit", () => {
      expect(
        parseChatLimitDetail(
          JSON.stringify({
            kind: "global",
            limit: 60,
            retry_after_seconds: 9,
            reset_at: 1_800_000_000,
          }),
        ),
      ).toEqual({
        kind: "global",
        limit: 60,
        retryAfterSeconds: 9,
        resetAt: 1_800_000_000,
      });
    });

    it.each([
      ["an unknown kind", { kind: "hourly", limit: 1, retry_after_seconds: 1, reset_at: 1 }],
      ["a zero retry", { kind: "daily", limit: 1, retry_after_seconds: 0, reset_at: 1 }],
      ["a missing limit", { kind: "daily", retry_after_seconds: 1, reset_at: 1 }],
      ["a string limit", { kind: "daily", limit: "40", retry_after_seconds: 1, reset_at: 1 }],
    ])("returns undefined for %s", (_, value) => {
      expect(parseChatLimitDetail(JSON.stringify(value))).toBeUndefined();
    });

    it("returns undefined for non-JSON, null and absent input", () => {
      expect(parseChatLimitDetail("not json")).toBeUndefined();
      expect(parseChatLimitDetail("null")).toBeUndefined();
      expect(parseChatLimitDetail(null)).toBeUndefined();
      expect(parseChatLimitDetail("")).toBeUndefined();
    });
  });

  describe("wording", () => {
    it.each([
      [45, "45 seconds"],
      [1, "1 second"],
      [600, "10 minutes"],
      [3600, "60 minutes"],
      [90 * 60, "2 hours"],
    ])("formatWait(%i) is %s", (seconds, want) => {
      expect(formatWait(seconds)).toBe(want);
    });

    it("names each limit kind in its message", () => {
      expect(chatRateLimitMessage("per_minute", 4, 30)).toContain("4 messages per minute");
      expect(chatRateLimitMessage("daily", 40, 30)).toContain("40 messages in 24 hours");
      expect(chatRateLimitMessage("monthly", 600, 30)).toContain("600 messages in 30 days");
      expect(chatRateLimitMessage("global", 60, 30)).toContain("busy");
    });
  });

  describe("buildUpstreamHeaders", () => {
    it("drops a client-supplied x-user-roles, and every other identity header, before forwarding", () => {
      const source = new Headers({
        "x-user-roles": "admin",
        "x-user-id": "attacker",
        "x-user-email": "attacker@example.com",
        "x-internal-secret": "attacker-secret",
        "content-type": "application/json",
      });

      const upstream = buildUpstreamHeaders(source, {
        internalSecret: "server-secret",
        userID: "user-1",
        userEmail: "user@example.com",
      });

      expect(upstream.get("x-user-roles")).toBeNull();
      expect(upstream.get("x-user-id")).toBe("user-1");
      expect(upstream.get("x-user-email")).toBe("user@example.com");
      expect(upstream.get("x-internal-secret")).toBe("server-secret");
      expect(upstream.get("content-type")).toBe("application/json");
    });
  });

  it("caps messages at the chat service's 2000-character default", () => {
    expect(CHAT_MAX_MESSAGE_CHARS).toBe(2000);
  });
});
