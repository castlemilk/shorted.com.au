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
import { appendSsrUserAgent, config, middleware } from "../middleware";

// Mock next-auth/jwt
jest.mock("next-auth/jwt", () => ({
  getToken: jest.fn(),
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
    it("matches the chat and payment API paths that need an API-shaped 401", () => {
      expect(config.matcher).toEqual(
        expect.arrayContaining([
          "/chat.v1.ChatService/:path*",
          "/api/stripe/checkout",
          "/api/stripe/portal",
        ]),
      );
    });

    it("no longer matches the read paths that existed only for the removed limiter", () => {
      // /api/market-data, /api/search and /api/community were matched purely
      // for the Upstash rate limiter. Their route handlers still call
      // rateLimit() directly and per-minute browser limiting now runs at the
      // Cloudflare edge, so a middleware invocation on them buys nothing.
      expect(config.matcher).not.toContain("/api/market-data/:path*");
      expect(config.matcher).not.toContain("/api/search/:path*");
      expect(config.matcher).not.toContain("/api/community/:path*");
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

  describe("First-party identity for rewrite-proxied traffic", () => {
    // Next.js rewrites cannot add headers, but middleware can. Without this
    // marker the Cloudflare worker sees a shared Vercel egress IP for every
    // anonymous visitor and cannot tell first-party traffic from a scraper —
    // which is why edge enforcement had to ship disabled.
    const SECRET = "ssr-secret-value-for-tests-0123456789";
    const REWRITE_PATHS = [
      "/shorts.v1alpha1.MarketService/GetTopShorts",
      "/shorts.v1alpha1.HousingService/ListSuburbs",
      "/register.v1.RegisterService/ListPoliticians",
      "/api/stocks/BHP",
      "/api/algolia/search",
      "/edge/v1/top-shorts",
    ];

    const originalSecret = process.env.SHORTED_SSR_BYPASS_SECRET;

    afterEach(() => {
      if (originalSecret === undefined) {
        delete process.env.SHORTED_SSR_BYPASS_SECRET;
      } else {
        process.env.SHORTED_SSR_BYPASS_SECRET = originalSecret;
      }
    });

    it.each(REWRITE_PATHS)(
      "stamps the SSR bypass secret and UA marker on %s",
      async (path) => {
        process.env.SHORTED_SSR_BYPASS_SECRET = SECRET;

        const response = await middleware(
          new NextRequest(`https://shorted.com.au${path}`, {
            method: "POST",
            headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/140" },
          }),
        );

        // NextResponse.next({ request: { headers } }) surfaces the overridden
        // request headers on this internal response header, which is what the
        // downstream rewrite actually forwards.
        const forwarded = response?.headers.get("x-middleware-override-headers");
        expect(forwarded).toContain("x-shorted-ssr-bypass");
        expect(
          response?.headers.get("x-middleware-request-x-shorted-ssr-bypass"),
        ).toBe(SECRET);

        expect(response?.headers.get("x-middleware-request-user-agent")).toContain(
          "shorted-web-ssr",
        );
      },
    );

    // NOTE: the UA-merge itself is asserted through appendSsrUserAgent rather
    // than through middleware(). The jest harness's Request polyfill exposes
    // NextRequest.headers as a bare Map, so no inbound request header survives
    // into the middleware at all — an end-to-end assertion here would be
    // testing the polyfill, not the code.
    describe("appendSsrUserAgent", () => {
      it("preserves the real client UA as a prefix", () => {
        expect(appendSsrUserAgent("Mozilla/5.0 (Macintosh) Chrome/140")).toBe(
          "Mozilla/5.0 (Macintosh) Chrome/140 shorted-web-ssr/1.0 (+https://shorted.com.au)",
        );
      });

      it("keeps a crawler identifiable so the edge never rate limits Googlebot", () => {
        expect(appendSsrUserAgent("Googlebot/2.1 (+http://www.google.com/bot.html)")).toContain(
          "Googlebot",
        );
      });

      it("is idempotent — a UA already carrying the marker is unchanged", () => {
        const already = "shorted-web-ssr/1.0 (+https://shorted.com.au)";
        expect(appendSsrUserAgent(already)).toBe(already);
        expect(appendSsrUserAgent(already).match(/shorted-web-ssr/g)).toHaveLength(1);
      });

      it("falls back to the canonical SSR UA when there is none", () => {
        expect(appendSsrUserAgent(null)).toContain("shorted-web-ssr");
        expect(appendSsrUserAgent("")).toContain("shorted-web-ssr");
      });
    });

    it("passes the request through unmarked when the secret is not configured", async () => {
      delete process.env.SHORTED_SSR_BYPASS_SECRET;

      const response = await middleware(
        new NextRequest(
          "https://shorted.com.au/shorts.v1alpha1.MarketService/GetTopShorts",
          { method: "POST" },
        ),
      );

      expect(response?.status).not.toBe(307);
      expect(
        response?.headers.get("x-middleware-request-x-shorted-ssr-bypass"),
      ).toBeNull();
    });

    it("never runs the auth/redirect work on a rewrite-proxied path", async () => {
      process.env.SHORTED_SSR_BYPASS_SECRET = SECRET;

      await middleware(
        new NextRequest(
          "https://shorted.com.au/shorts.v1alpha1.MarketService/GetTopShorts",
          { method: "POST" },
        ),
      );

      expect(mockGetToken).not.toHaveBeenCalled();
    });

    it("does not stamp the marker on ordinary page routes", async () => {
      process.env.SHORTED_SSR_BYPASS_SECRET = SECRET;

      const response = await middleware(
        new NextRequest("https://shorted.com.au/shorts/BHP"),
      );

      expect(
        response?.headers.get("x-middleware-request-x-shorted-ssr-bypass"),
      ).toBeNull();
    });

    it("the matcher covers every rewrite source in next.config.mjs", () => {
      expect(config.matcher).toEqual(
        expect.arrayContaining([
          "/:service(shorts\\.v1alpha1\\.[A-Za-z]+Service)/:path*",
          "/register.v1.RegisterService/:path*",
          "/api/stocks/:path*",
          "/api/algolia/:path*",
          "/edge/v1/:path*",
        ]),
      );
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
