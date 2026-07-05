/**
 * Tests for middleware authentication functionality
 *
 * These tests ensure that:
 * 1. Middleware correctly reads session cookies with custom names
 * 2. Protected routes allow authenticated users
 * 3. Protected routes redirect unauthenticated users
 * 4. Cookie name configuration matches between auth.ts and middleware.ts
 */

import { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
// Import middleware function - Next.js middleware files export as named export
import { BROWSER_RATE_LIMITS, config, middleware } from "../middleware";

// Mock next-auth/jwt
jest.mock("next-auth/jwt", () => ({
  getToken: jest.fn(),
}));

// Mock Upstash Redis (for rate limiting)
jest.mock("@upstash/redis", () => ({
  Redis: jest.fn(),
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

const mockGetToken = getToken as jest.MockedFunction<typeof getToken>;

describe("Middleware Authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment
    process.env.NODE_ENV = "production";
    process.env.NEXTAUTH_SECRET = "test-secret";
  });

  describe("Cookie Name Configuration", () => {
    it("uses __Secure- prefix cookie name in production", async () => {
      process.env.NODE_ENV = "production";

      const request = new NextRequest("https://example.com/dashboards", {
        headers: {
          cookie: "__Secure-next-auth.session-token=test-token",
        },
      });

      mockGetToken.mockResolvedValue({
        sub: "user@example.com",
        email: "user@example.com",
      } as any);

      await middleware(request);

      expect(mockGetToken).toHaveBeenCalledWith(
        expect.objectContaining({
          cookieName: "__Secure-next-auth.session-token",
          secret: "test-secret",
        }),
      );
    });

    it("uses standard cookie name in development", async () => {
      process.env.NODE_ENV = "development";

      const request = new NextRequest("http://localhost:3000/dashboards", {
        headers: {
          cookie: "next-auth.session-token=test-token",
        },
      });

      mockGetToken.mockResolvedValue({
        sub: "user@example.com",
        email: "user@example.com",
      } as any);

      await middleware(request);

      expect(mockGetToken).toHaveBeenCalledWith(
        expect.objectContaining({
          cookieName: "next-auth.session-token",
          secret: "test-secret",
        }),
      );
    });
  });

  describe("Protected Routes - Authenticated Users", () => {
    const protectedRoutes = ["/dashboards", "/portfolio", "/chat"];

    protectedRoutes.forEach((route) => {
      it(`allows authenticated user to access ${route}`, async () => {
        const request = new NextRequest(`https://example.com${route}`, {
          headers: {
            cookie: "__Secure-next-auth.session-token=valid-token",
          },
        });

        mockGetToken.mockResolvedValue({
          sub: "user@example.com",
          email: "user@example.com",
          id: "user-id",
        } as any);

        const response = await middleware(request);

        // Should not redirect (status should be undefined or 200)
        expect(response?.status).not.toBe(307); // 307 is redirect
        expect(mockGetToken).toHaveBeenCalledWith(
          expect.objectContaining({
            cookieName: "__Secure-next-auth.session-token",
          }),
        );
      });
    });
  });

  describe("Protected Routes - Unauthenticated Users", () => {
    const protectedRoutes = ["/dashboards", "/portfolio", "/chat"];

    protectedRoutes.forEach((route) => {
      it(`redirects unauthenticated user from ${route} to signin`, async () => {
        const request = new NextRequest(`https://example.com${route}`, {
          headers: {},
        });

        mockGetToken.mockResolvedValue(null);

        const response = await middleware(request);

        expect(response).toBeDefined();
        // Check that redirect was attempted
        const isRedirect =
          response?.status === 307 || response?.headers.get("location");
        expect(isRedirect).toBeTruthy();
        if (response?.headers.get("location")) {
          const location = response.headers.get("location");
          expect(location).toContain("/signin");
          expect(location).toContain(
            `callbackUrl=${encodeURIComponent(route)}`,
          );
        }
      });

      it(`redirects when token exists but has no sub field from ${route}`, async () => {
        const request = new NextRequest(`https://example.com${route}`, {
          headers: {
            cookie: "__Secure-next-auth.session-token=invalid-token",
          },
        });

        // Token exists but missing sub field
        mockGetToken.mockResolvedValue({
          email: "user@example.com",
          // No sub field!
        } as any);

        const response = await middleware(request);

        expect(response).toBeDefined();
        // Check that redirect was attempted
        const isRedirect =
          response?.status === 307 || response?.headers.get("location");
        expect(isRedirect).toBeTruthy();
        if (response?.headers.get("location")) {
          expect(response.headers.get("location")).toContain("/signin");
        }
      });
    });
  });

  describe("Cost-sensitive API protection", () => {
    it("uses generous browser buckets so normal web traffic does not collide with API limits", () => {
      expect(
        BROWSER_RATE_LIMITS.anonymousRequestsPerMinute,
      ).toBeGreaterThanOrEqual(600);
      expect(
        BROWSER_RATE_LIMITS.authenticatedRequestsPerMinute,
      ).toBeGreaterThanOrEqual(3000);
    });

    it("gives anonymous browser traffic a refillable 3000 request burst bucket", () => {
      expect(BROWSER_RATE_LIMITS.anonymousBurstMaxTokens).toBe(3000);
      expect(BROWSER_RATE_LIMITS.anonymousRefillRequestsPerWindow).toBe(
        BROWSER_RATE_LIMITS.anonymousRequestsPerMinute,
      );
    });

    it("initializes the anonymous browser limiter as a token bucket", () => {
      const originalKvUrl = process.env.KV_REST_API_URL;
      const originalKvToken = process.env.KV_REST_API_TOKEN;
      process.env.KV_REST_API_URL = "https://redis.example";
      process.env.KV_REST_API_TOKEN = "token";

      try {
        jest.isolateModules(() => {
          jest.requireActual("../middleware");
        });
      } finally {
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
      }

      const { Ratelimit } = jest.requireMock("@upstash/ratelimit") as {
        Ratelimit: jest.Mock & {
          tokenBucket: jest.Mock;
          slidingWindow: jest.Mock;
        };
      };

      expect(Ratelimit.tokenBucket).toHaveBeenCalledWith(600, "60 s", 3000);
      expect(Ratelimit.slidingWindow).toHaveBeenCalledWith(3000, "60 s");
    });

    it("initializes distributed browser rate limiting from REDIS_URL", () => {
      const originalKvUrl = process.env.KV_REST_API_URL;
      const originalKvToken = process.env.KV_REST_API_TOKEN;
      const originalRedisUrl = process.env.REDIS_URL;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
      process.env.REDIS_URL =
        "rediss://default:secret%2Ftoken@settled-redfish-12345.upstash.io:6379";

      try {
        jest.isolateModules(() => {
          jest.requireActual("../middleware");
        });
      } finally {
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
        if (originalRedisUrl === undefined) {
          delete process.env.REDIS_URL;
        } else {
          process.env.REDIS_URL = originalRedisUrl;
        }
      }

      const { Redis } = jest.requireMock("@upstash/redis") as {
        Redis: jest.Mock;
      };

      expect(Redis).toHaveBeenCalledWith({
        url: "https://settled-redfish-12345.upstash.io",
        token: "secret/token",
      });
    });

    it("does not initialize edge rate limiting from non-REST Redis URLs", () => {
      const originalKvUrl = process.env.KV_REST_API_URL;
      const originalKvToken = process.env.KV_REST_API_TOKEN;
      const originalRedisUrl = process.env.REDIS_URL;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
      process.env.REDIS_URL =
        "redis://default:secret@redis-11815.c291.ap-southeast-2-1.ec2.cloud.redislabs.com:11815";

      try {
        jest.isolateModules(() => {
          jest.requireActual("../middleware");
        });
      } finally {
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
        if (originalRedisUrl === undefined) {
          delete process.env.REDIS_URL;
        } else {
          process.env.REDIS_URL = originalRedisUrl;
        }
      }

      const { Redis } = jest.requireMock("@upstash/redis") as {
        Redis: jest.Mock;
      };

      expect(Redis).not.toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("redislabs.com"),
        }),
      );
    });

    it("matches chat, payment, and community API paths in middleware", () => {
      expect(config.matcher).toEqual(
        expect.arrayContaining([
          "/chat.v1.ChatService/:path*",
          "/api/stripe/checkout",
          "/api/stripe/portal",
          "/api/community/:path*",
        ]),
      );
    });

    it("rejects unauthenticated direct chat RPC requests", async () => {
      const request = new NextRequest(
        "https://example.com/chat.v1.ChatService/SendMessage",
        {
          method: "POST",
        },
      );

      mockGetToken.mockResolvedValue(null);

      const response = await middleware(request);

      expect(response?.status).toBe(401);
    });
  });

  describe("Public Routes", () => {
    const publicRoutes = ["/", "/about", "/blog", "/signin"];

    publicRoutes.forEach((route) => {
      it(`allows unauthenticated access to ${route}`, async () => {
        const request = new NextRequest(`https://example.com${route}`, {
          headers: {},
        });

        mockGetToken.mockResolvedValue(null);

        const response = await middleware(request);

        // Should not redirect
        expect(response?.status).not.toBe(307);
      });
    });
  });

  describe("Error Handling", () => {
    it("redirects to signin when getToken throws an error", async () => {
      const request = new NextRequest("https://example.com/dashboards", {
        headers: {
          cookie: "__Secure-next-auth.session-token=test-token",
        },
      });

      mockGetToken.mockRejectedValue(new Error("Token decryption failed"));

      const response = await middleware(request);

      // Should return a redirect response
      expect(response).toBeDefined();
      // Check that redirect was attempted (either status 307 or location header)
      const isRedirect =
        response?.status === 307 || response?.headers.get("location");
      expect(isRedirect).toBeTruthy();
      if (response?.headers.get("location")) {
        expect(response.headers.get("location")).toContain("/signin");
      }
    });

    it("handles missing NEXTAUTH_SECRET gracefully", async () => {
      delete process.env.NEXTAUTH_SECRET;

      const request = new NextRequest("https://example.com/dashboards", {
        headers: {
          cookie: "__Secure-next-auth.session-token=test-token",
        },
      });

      mockGetToken.mockResolvedValue(null);

      const response = await middleware(request);

      // Should redirect (can't verify token without secret)
      expect(response).toBeDefined();
      const isRedirect =
        response?.status === 307 || response?.headers.get("location");
      expect(isRedirect).toBeTruthy();
    });
  });

  describe("Cookie Name Consistency", () => {
    it("ensures middleware uses same cookie name as auth config in production", () => {
      process.env.NODE_ENV = "production";

      // This test ensures that if we change the cookie name in auth.ts,
      // we must also update middleware.ts
      const expectedCookieName = "__Secure-next-auth.session-token";

      const request = new NextRequest("https://example.com/dashboards", {
        headers: {
          cookie: `${expectedCookieName}=test-token`,
        },
      });

      mockGetToken.mockResolvedValue({
        sub: "user@example.com",
      } as any);

      middleware(request);

      expect(mockGetToken).toHaveBeenCalledWith(
        expect.objectContaining({
          cookieName: expectedCookieName,
        }),
      );
    });

    it("ensures middleware uses same cookie name as auth config in development", () => {
      process.env.NODE_ENV = "development";

      const expectedCookieName = "next-auth.session-token";

      const request = new NextRequest("http://localhost:3000/dashboards", {
        headers: {
          cookie: `${expectedCookieName}=test-token`,
        },
      });

      mockGetToken.mockResolvedValue({
        sub: "user@example.com",
      } as any);

      middleware(request);

      expect(mockGetToken).toHaveBeenCalledWith(
        expect.objectContaining({
          cookieName: expectedCookieName,
        }),
      );
    });
  });

  describe("Token Field Requirements", () => {
    it("requires token.sub field for authentication", async () => {
      const request = new NextRequest("https://example.com/dashboards", {
        headers: {
          cookie: "__Secure-next-auth.session-token=test-token",
        },
      });

      // Token with email but no sub
      mockGetToken.mockResolvedValue({
        email: "user@example.com",
        id: "user-id",
        // Missing sub!
      } as any);

      const response = await middleware(request);

      // Should redirect because sub is required
      expect(response).toBeDefined();
      const isRedirect =
        response?.status === 307 || response?.headers.get("location");
      expect(isRedirect).toBeTruthy();
      if (response?.headers.get("location")) {
        expect(response.headers.get("location")).toContain("/signin");
      }
    });

    it("allows access when token has sub field", async () => {
      const request = new NextRequest("https://example.com/dashboards", {
        headers: {
          cookie: "__Secure-next-auth.session-token=test-token",
        },
      });

      mockGetToken.mockResolvedValue({
        sub: "user@example.com",
        email: "user@example.com",
      } as any);

      const response = await middleware(request);

      // Should not redirect
      expect(response?.status).not.toBe(307);
    });
  });
});
