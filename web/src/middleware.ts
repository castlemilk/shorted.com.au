import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getToken } from "next-auth/jwt";

// Initialize Redis client for rate limiting
// Will use in-memory fallback if KV not configured (development)
let redis: Redis | null = null;
let anonymousLimiter: Ratelimit | null = null;
let authenticatedLimiter: Ratelimit | null = null;

// Only initialize if Vercel KV is configured
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  // Anonymous users: 20 requests per minute
  anonymousLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(20, "60 s"),
    analytics: true,
    prefix: "ratelimit:anon",
  });

  // Authenticated users: 200 requests per minute
  authenticatedLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(200, "60 s"),
    analytics: true,
    prefix: "ratelimit:auth",
  });
}

// Paths that should be rate limited
const RATE_LIMITED_PATHS = ["/api/market-data", "/api/search"];

// Protected page routes that require authentication
const PROTECTED_ROUTES = ["/dashboards", "/portfolio"];
// Note: /shorts/[stockCode] is public for SEO, only /shorts list view is protected

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always bypass auth routes completely to avoid interfering with CSRF
  if (pathname.startsWith("/api/auth") || pathname.startsWith("/api/health")) {
    return NextResponse.next();
  }

  // Check if this is a protected route
  // Special case: /shorts is protected, but /shorts/[stockCode] is public
  const isProtectedRoute =
    pathname === "/shorts" ||
    PROTECTED_ROUTES.some((route) => pathname.startsWith(route));

  // Enforce authentication for protected routes
  if (isProtectedRoute) {
    try {
      // Check for session cookie in request
      const cookies = request.cookies;
      const sessionCookie =
        cookies.get("__Secure-next-auth.session-token") ??
        cookies.get("next-auth.session-token");

      console.log("[Middleware] Cookie check:", {
        pathname,
        hasSessionCookie: !!sessionCookie,
        cookieNames: Array.from(cookies.getAll().map((c) => c.name)),
        hasSecret: !!process.env.NEXTAUTH_SECRET,
      });

      const token = await getToken({
        req: request,
        secret: process.env.NEXTAUTH_SECRET,
        cookieName:
          process.env.NODE_ENV === "production"
            ? "__Secure-next-auth.session-token"
            : "next-auth.session-token",
      });

      // Debug logging for Vercel
      console.log("[Middleware] Token check:", {
        pathname,
        hasToken: !!token,
        hasSub: !!token?.sub,
        hasId: !!token?.id,
        hasEmail: !!token?.email,
        tokenKeys: token ? Object.keys(token) : [],
        tokenSub: token?.sub,
        tokenId: token?.id,
        tokenEmail: token?.email,
      });

      // If no valid session, redirect to signin
      if (!token?.sub) {
        console.log("[Middleware] No token.sub found, redirecting to signin");
        const url = new URL("/signin", request.url);
        url.searchParams.set("callbackUrl", pathname);
        return NextResponse.redirect(url);
      }

      console.log("[Middleware] Auth check passed for:", token.sub);
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
  if (shouldRateLimit && redis && anonymousLimiter && authenticatedLimiter) {
    try {
      // Check authentication - but don't call getToken if we're near auth routes
      // to avoid any cookie/session interference
      let token = null;
      try {
        token = await getToken({
          req: request,
          secret: process.env.NEXTAUTH_SECRET,
          cookieName:
            process.env.NODE_ENV === "production"
              ? "__Secure-next-auth.session-token"
              : "next-auth.session-token",
        });
      } catch (error) {
        // If getToken fails, treat as anonymous user
        console.error("Error getting auth token in middleware:", error);
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
      // Log error but don't block requests if rate limiting fails
      console.error("Rate limiting error:", error);
      return NextResponse.next();
    }
  }

  // No rate limiting applied, continue
  return NextResponse.next();
}

// Configure which routes use this middleware
export const config = {
  matcher: [
    /*
     * API routes for rate limiting
     */
    "/api/market-data/:path*",
    "/api/search/:path*",
    /*
     * Protected page routes (require authentication)
     * Note: /shorts/[stockCode] pages are NOT protected (public for SEO)
     */
    "/dashboards",
    "/dashboards/:path*",
    "/portfolio",
    "/portfolio/:path*",
    "/shorts", // Only the list view, not individual stock pages
    "/stocks",
    "/stocks/:path*",
  ],
};
