import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getToken } from "next-auth/jwt";
import { getUpstashRedisRestConfig } from "./@/lib/redis-env";

// Initialize Redis client for rate limiting
// Will use in-memory fallback if KV not configured (development)
let redis: Redis | null = null;
let anonymousLimiter: Ratelimit | null = null;
let authenticatedLimiter: Ratelimit | null = null;

export const BROWSER_RATE_LIMITS = {
  anonymousRequestsPerMinute: 600,
  anonymousRefillRequestsPerWindow: 600,
  anonymousBurstMaxTokens: 3000,
  authenticatedRequestsPerMinute: 3000,
  windowSeconds: 60,
};

const redisConfig = getUpstashRedisRestConfig(process.env);

// Only initialize if Vercel KV/Upstash Redis is configured
if (redisConfig) {
  redis = new Redis({
    url: redisConfig.url,
    token: redisConfig.token,
  });

  // Browser traffic is intentionally bucketed generously. Strict API usage is
  // handled at api.shorted.com.au by Cloudflare's API-host rate limit.
  anonymousLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.tokenBucket(
      BROWSER_RATE_LIMITS.anonymousRefillRequestsPerWindow,
      `${BROWSER_RATE_LIMITS.windowSeconds} s`,
      BROWSER_RATE_LIMITS.anonymousBurstMaxTokens,
    ),
    analytics: true,
    prefix: `ratelimit:browser:anon:burst:${BROWSER_RATE_LIMITS.anonymousRefillRequestsPerWindow}:${BROWSER_RATE_LIMITS.windowSeconds}:${BROWSER_RATE_LIMITS.anonymousBurstMaxTokens}`,
  });

  authenticatedLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(
      BROWSER_RATE_LIMITS.authenticatedRequestsPerMinute,
      `${BROWSER_RATE_LIMITS.windowSeconds} s`,
    ),
    analytics: true,
    prefix: `ratelimit:browser:auth:${BROWSER_RATE_LIMITS.authenticatedRequestsPerMinute}:${BROWSER_RATE_LIMITS.windowSeconds}`,
  });
}

// Paths that should be rate limited
const RATE_LIMITED_PATHS = [
  "/api/market-data",
  "/api/search",
  "/api/community",
  "/api/stripe/checkout",
  "/api/stripe/portal",
  "/chat.v1.ChatService",
];

// Protected page routes that require authentication
// Note: /shorts and /stocks are public for SEO (Googlebot needs to crawl them)
const PROTECTED_ROUTES = [
  "/dashboards",
  "/portfolio",
  "/admin",
  "/developer",
  "/chat",
];

// Protected API/RPC routes should return API-shaped 401 responses, not signin redirects.
const AUTH_REQUIRED_API_PATHS = [
  "/api/stripe/checkout",
  "/api/stripe/portal",
  "/chat.v1.ChatService",
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always bypass auth routes completely to avoid interfering with CSRF
  if (pathname.startsWith("/api/auth") || pathname.startsWith("/api/health")) {
    return NextResponse.next();
  }

  // Canonicalize stock-code case: /shorts/lot → 301 → /shorts/LOT.
  // Case variants returning 200 waste crawl budget on duplicate URLs that
  // only the canonical tag disambiguates.
  const caseMatch =
    /^\/(shorts|insider-trading)\/([A-Za-z0-9]{1,5})(\/.*)?$/.exec(pathname);
  if (caseMatch) {
    const code = caseMatch[2]!;
    const upper = code.toUpperCase();
    if (code !== upper) {
      const url = request.nextUrl.clone();
      url.pathname = `/${caseMatch[1]}/${upper}${caseMatch[3] ?? ""}`;
      return NextResponse.redirect(url, 301);
    }
  }

  // Weekly report slugs: 301 the ISO form ("2026-W29") to the canonical
  // query-matching path ("10-most-shorted-asx-stocks-week-29-2026").
  // Must happen HERE: a redirect thrown from the streamed page body (behind
  // loading.tsx) degrades to a 200 + meta-refresh, not a real 301.
  // Mirrors ~/@/lib/reports/weekly-slug.ts (kept dependency-free on purpose).
  const weeklyIso = /^\/reports\/weekly\/(\d{4})-W(\d{2})$/.exec(pathname);
  if (weeklyIso) {
    const url = request.nextUrl.clone();
    url.pathname = `/reports/weekly/10-most-shorted-asx-stocks-week-${parseInt(
      weeklyIso[2]!,
      10,
    )}-${weeklyIso[1]}`;
    return NextResponse.redirect(url, 301);
  }
  // Zero-padded week variant ("week-05-2026") → canonical unpadded form,
  // so the padded spelling can't serve a duplicate 200.
  const weeklyPadded =
    /^\/reports\/weekly\/(10-most-shorted-asx-stocks-week-)0(\d)(-\d{4})$/.exec(
      pathname,
    );
  if (weeklyPadded) {
    const url = request.nextUrl.clone();
    url.pathname = `/reports/weekly/${weeklyPadded[1]}${weeklyPadded[2]}${weeklyPadded[3]}`;
    return NextResponse.redirect(url, 301);
  }

  // Check if this is a protected route
  const requiresApiAuth = AUTH_REQUIRED_API_PATHS.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  if (requiresApiAuth) {
    try {
      const token = await readSessionToken(request);

      if (!token?.sub) {
        return NextResponse.json(
          { error: "Authentication required" },
          { status: 401 },
        );
      }
    } catch (error) {
      console.error("[Middleware] API auth check error:", error);
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
  }

  const isProtectedRoute = PROTECTED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  // Enforce authentication for protected page routes
  if (isProtectedRoute) {
    try {
      const token = await readSessionToken(request);

      // If no valid session, redirect to signin
      if (!token?.sub) {
        const url = new URL("/signin", request.url);
        url.searchParams.set("callbackUrl", pathname);
        return NextResponse.redirect(url);
      }

      // Admin route protection
      if (pathname.startsWith("/admin") && !token.isAdmin) {
        return NextResponse.redirect(new URL("/", request.url));
      }
    } catch (error) {
      console.error("[Middleware] Auth check error:", error);
      // On error, redirect to signin to be safe
      const url = new URL("/signin", request.url);
      url.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(url);
    }
  }

  // Check if this path should be rate limited
  const shouldRateLimit = RATE_LIMITED_PATHS.some((path) =>
    pathname.startsWith(path),
  );

  // Apply rate limiting if configured and path matches
  if (
    shouldRateLimit &&
    (!redis || !anonymousLimiter || !authenticatedLimiter)
  ) {
    if (shouldFailClosedWithoutRedis()) {
      return NextResponse.json(
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
      );
    }
  }

  if (shouldRateLimit && redis && anonymousLimiter && authenticatedLimiter) {
    try {
      // Check authentication - but don't call getToken if we're near auth routes
      // to avoid any cookie/session interference
      let token = null;
      try {
        token = await readSessionToken(request);
      } catch (error) {
        // If getToken fails, treat as anonymous user
      }

      // Determine identifier and rate limiter
      const isAuthenticated = !!token?.sub;
      const identifier = isAuthenticated
        ? `user:${token?.sub ?? "unknown"}`
        : `ip:${request.ip ?? request.headers.get("x-forwarded-for") ?? "unknown"}`;

      // Use appropriate rate limiter
      const limiter = isAuthenticated ? authenticatedLimiter : anonymousLimiter;

      // Check rate limit
      const { success, limit, remaining, reset } =
        await limiter.limit(identifier);

      // If rate limit exceeded, return 429
      if (!success) {
        const retryAfter = Math.ceil((reset - Date.now()) / 1000);
        return NextResponse.json(
          {
            error: "Rate limit exceeded",
            message: isAuthenticated
              ? `You have exceeded the rate limit. Please try again in ${retryAfter} seconds.`
              : `Rate limit exceeded. Sign in for higher limits, or try again in ${retryAfter} seconds.`,
            retryAfter,
            limit,
            authenticated: isAuthenticated,
          },
          {
            status: 429,
            headers: {
              "X-RateLimit-Limit": limit.toString(),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": new Date(reset).toISOString(),
              "Retry-After": retryAfter.toString(),
            },
          },
        );
      }

      // Add rate limit headers to response
      const response = NextResponse.next();
      response.headers.set("X-RateLimit-Limit", limit.toString());
      response.headers.set("X-RateLimit-Remaining", remaining.toString());
      response.headers.set("X-RateLimit-Reset", new Date(reset).toISOString());
      return response;
    } catch (error) {
      if (shouldFailClosedWithoutRedis()) {
        return NextResponse.json(
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
        );
      }

      // Don't block requests if rate limiting fails outside production
      return NextResponse.next();
    }
  }

  // No rate limiting applied, continue
  return NextResponse.next();
}

function readSessionToken(request: NextRequest) {
  return getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
    cookieName:
      process.env.NODE_ENV === "production"
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token",
  });
}

function shouldFailClosedWithoutRedis(): boolean {
  return (
    process.env.RATE_LIMIT_REQUIRE_DISTRIBUTED === "true" &&
    process.env.RATE_LIMIT_FAIL_OPEN !== "true"
  );
}

// Configure which routes use this middleware
export const config = {
  matcher: [
    /*
     * API routes for rate limiting
     */
    "/api/market-data/:path*",
    "/api/search/:path*",
    "/api/community/:path*",
    "/api/stripe/checkout",
    "/api/stripe/portal",
    "/chat.v1.ChatService/:path*",
    /*
     * Protected page routes (require authentication)
     * Note: /shorts, /stocks, and /shorts/[stockCode] are public for SEO
     */
    "/dashboards",
    "/dashboards/:path*",
    "/portfolio",
    "/portfolio/:path*",
    "/admin",
    "/admin/:path*",
    "/developer",
    "/chat",
    "/chat/:path*",
    /*
     * Stock pages: case-canonicalization redirect only (public, no auth)
     */
    "/shorts/:code",
    "/shorts/:code/:path*",
    "/insider-trading/:code",
    /*
     * Weekly reports: ISO-slug → canonical-slug 301 only (public, no auth).
     * NOTE: a trailing single param (":slug") compiles to an optional .json
     * suffix and never matches a real segment — the catch-all form is
     * required (same reason the /shorts matcher needs :code/:path*).
     */
    "/reports/weekly/:slug*",
  ],
};
