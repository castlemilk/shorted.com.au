import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

// ---------------------------------------------------------------------------
// Browser rate limiting no longer lives here.
//
// This middleware used to run an Upstash sliding-window/token-bucket check on
// every request to an API-ish path. That put a Redis round trip in front of
// hot browser traffic, against the same Upstash database that backs the page
// cache — the coupling that exhausted the command quota and simultaneously
// degraded rate limiting and froze the cache.
//
// Per-minute browser limiting is now enforced at the Cloudflare edge, in
// services/edge-worker/worker.js, on the shorted.com.au route — which is the
// only place that sees the REAL client IP (here, behind the CDN, it does not)
// and which rejects a request before it costs a Vercel invocation at all.
// Per-TIER limits and monthly quotas are enforced in-process by the Go API
// (services/pkg/ratelimit); individual route handlers still call
// `rateLimit()` from ~/@/lib/rate-limit for their own per-route ceilings.
//
// What remains here is auth, canonicalisation redirects, and the first-party
// identity marker below.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// First-party identity for rewrite-proxied traffic
//
// THE PROBLEM THIS SOLVES. next.config.mjs rewrites the Connect-RPC paths to
// api.shorted.com.au on purpose, so client-side reads hit the Cloudflare Worker
// cache. That rewrite is performed BY VERCEL, so by the time the request
// reaches the worker its source address is a shared Vercel egress IP — every
// anonymous visitor in a region collapses onto a handful of addresses. An
// anonymous per-IP bucket at the API edge would therefore 429 real users, which
// is exactly why the edge limiter shipped with enforcement disabled.
//
// THE FIX. Next.js rewrites cannot add headers, but middleware can: request
// headers set via `NextResponse.next({ request: { headers } })` are what the
// downstream rewrite sends to its destination. So we stamp the SAME first-party
// marker the SSR fetcher uses (web/src/app/actions/config.ts) — the secret
// header AND the user-agent marker, never one alone — and the worker routes
// those requests into a first-party runaway bucket instead of the anonymous
// per-IP one. The end user is still limited: by their REAL IP, one hop earlier,
// on the shorted.com.au worker route.
//
// COST. This adds a middleware invocation to the RPC paths, which is why the
// handler short-circuits on them before any other work.
// ---------------------------------------------------------------------------

// Mirrors the rewrite rules in web/next.config.mjs. Anything Vercel proxies to
// the shorts API / edge host belongs here.
const REWRITE_PROXIED_PREFIXES = [
  "/register.v1.RegisterService/",
  "/api/stocks/",
  "/api/algolia/",
  "/edge/v1/",
];

// One regex covers every shorts.v1alpha1 domain service, matching the
// regex-constrained rewrite source in next.config.mjs, so a new domain service
// gets the marker without touching this file.
const REWRITE_PROXIED_PATTERN = /^\/shorts\.v1alpha1\.[A-Za-z]+Service\//;

// Kept in sync with web/src/app/actions/config.ts (the SSR fetcher) and with
// terraform/modules/cloudflare-edge (the zone skip rule + worker vars). The
// worker requires BOTH the UA marker and the exact secret — never the UA alone.
const SSR_BYPASS_HEADER = "x-shorted-ssr-bypass";
const SSR_USER_AGENT_MARKER = "shorted-web-ssr";
const SSR_USER_AGENT = "shorted-web-ssr/1.0 (+https://shorted.com.au)";

function isRewriteProxiedPath(pathname: string): boolean {
  return (
    REWRITE_PROXIED_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    REWRITE_PROXIED_PATTERN.test(pathname)
  );
}

/**
 * Append the first-party marker to a user-agent without clobbering it.
 *
 * The original UA is preserved as a PREFIX so downstream bot detection — and
 * crawler identification at the Cloudflare edge, where a verified Googlebot
 * must never be rate limited — still sees the true client. Idempotent: a UA
 * that already carries the marker is returned unchanged, so a request that
 * passed through the SSR fetcher and then this middleware is not double-tagged.
 */
export function appendSsrUserAgent(userAgent: string | null): string {
  if (!userAgent) return SSR_USER_AGENT;
  return userAgent.includes(SSR_USER_AGENT_MARKER)
    ? userAgent
    : `${userAgent} ${SSR_USER_AGENT}`;
}

/**
 * Stamp the first-party marker onto a rewrite-proxied request.
 *
 * Returns `null` when the secret is not configured — in that case the request
 * passes through unmarked and the edge treats it as anonymous, which is the
 * status quo, not a regression.
 *
 * The user-agent is APPENDED to, not replaced: the original UA is preserved as
 * a prefix so downstream bot detection (and crawler identification at the edge)
 * still sees the true client.
 */
export function withFirstPartyMarker(request: NextRequest): NextResponse | null {
  const secret = process.env.SHORTED_SSR_BYPASS_SECRET?.trim();
  if (!secret) return null;

  const headers = new Headers(request.headers);
  headers.set(SSR_BYPASS_HEADER, secret);

  headers.set("user-agent", appendSsrUserAgent(headers.get("user-agent")));

  return NextResponse.next({ request: { headers } });
}

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

  // Rewrite-proxied API traffic: stamp the first-party marker and get out.
  // Deliberately the first branch after the auth bypass — these are the hottest
  // paths in the app and none of the work below applies to them.
  if (isRewriteProxiedPath(pathname)) {
    return withFirstPartyMarker(request) ?? NextResponse.next();
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

// Configure which routes use this middleware
export const config = {
  matcher: [
    /*
     * Rewrite-proxied API traffic — matched ONLY to stamp the first-party
     * marker (see withFirstPartyMarker). These mirror the rewrite sources in
     * next.config.mjs; without the marker the Cloudflare worker sees a shared
     * Vercel egress IP and cannot tell first-party traffic from an anonymous
     * scraper. A trailing single param compiles to an optional .json suffix, so
     * the catch-all form is required on every one of these.
     */
    // Character-for-character the rewrite source in next.config.mjs, so the
    // two can never drift into matching different sets of services.
    "/:service(shorts\\.v1alpha1\\.[A-Za-z]+Service)/:path*",
    "/register.v1.RegisterService/:path*",
    "/api/stocks/:path*",
    "/api/algolia/:path*",
    "/edge/v1/:path*",
    /*
     * API/RPC routes that need an API-shaped 401.
     * NOTE: /api/market-data, /api/search and /api/community were matched here
     * purely for the removed Upstash rate limiter. Their own route handlers
     * still call rateLimit() directly, and per-minute browser limiting now runs
     * at the edge, so keeping a middleware invocation on them bought nothing.
     */
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
