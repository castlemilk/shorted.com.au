import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "~/server/auth";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitConfig {
  /** Requests allowed per window for unauthenticated users */
  anonymousLimit: number;
  /** Requests allowed per window for authenticated users */
  authenticatedLimit: number;
  /** Window duration in seconds */
  windowSeconds: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  anonymousLimit: 50,
  authenticatedLimit: 500,
  windowSeconds: 60, // 1 minute
};

// Initialize Redis client for rate limiting (Vercel KV)
let redis: Redis | null = null;
let anonymousLimiter: Ratelimit | null = null;
let authenticatedLimiter: Ratelimit | null = null;

// Initialize if Vercel KV is configured
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
} else {
  console.warn(
    "⚠️  Vercel KV not configured. Rate limiting will use in-memory fallback (not recommended for production)",
  );
}

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
): Promise<{ success: boolean; response?: NextResponse }> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  // Check if user is authenticated
  const session = await auth();
  const isAuthenticated = !!session?.user?.id;

  // Determine the rate limit to apply
  const limit = isAuthenticated
    ? finalConfig.authenticatedLimit
    : finalConfig.anonymousLimit;

  // Get identifier (user ID for authenticated, IP for anonymous)
  const identifier = isAuthenticated
    ? `user:${session.user.id}`
    : `ip:${getClientIp(request)}`;

  // Use Upstash Ratelimit if Redis is configured, otherwise fallback to in-memory
  if (redis) {
    // Initialize limiters if not already done
    if (!anonymousLimiter || !authenticatedLimiter) {
      anonymousLimiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(
          finalConfig.anonymousLimit,
          `${finalConfig.windowSeconds} s`,
        ),
        analytics: true,
        prefix: "ratelimit:api:anon",
      });

      authenticatedLimiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(
          finalConfig.authenticatedLimit,
          `${finalConfig.windowSeconds} s`,
        ),
        analytics: true,
        prefix: "ratelimit:api:auth",
      });
    }

    const limiter = isAuthenticated ? authenticatedLimiter : anonymousLimiter;
    if (!limiter) {
      // Fallback if limiter not initialized
      return { success: true };
    }

    const result = await limiter.limit(identifier);

    if (!result.success) {
      const resetInSeconds = Math.ceil((result.reset - Date.now()) / 1000);

      return {
        success: false,
        response: NextResponse.json(
          {
            error: "Rate limit exceeded",
            message: isAuthenticated
              ? `You have exceeded the rate limit. Please try again in ${resetInSeconds} seconds.`
              : `Rate limit exceeded. Sign in for higher limits, or try again in ${resetInSeconds} seconds.`,
            retryAfter: resetInSeconds,
            limit,
            authenticated: isAuthenticated,
          },
          {
            status: 429,
            headers: {
              "X-RateLimit-Limit": limit.toString(),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": result.reset.toString(),
              "Retry-After": resetInSeconds.toString(),
            },
          },
        ),
      };
    }

    // Return success - headers will be set by the caller if needed
    return { success: true };
  }

  // Fallback: In-memory rate limiting (development only)
  console.warn(
    "Using in-memory rate limiting fallback. Configure Vercel KV for production.",
  );
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
