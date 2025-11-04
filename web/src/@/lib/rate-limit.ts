import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/auth";

interface RateLimitStore {
  count: number;
  resetTime: number;
}

// In-memory store for rate limiting
// For production, consider using Redis or a dedicated rate limiting service
const rateLimitStore = new Map<string, RateLimitStore>();

export interface RateLimitConfig {
  /** Requests allowed per window for unauthenticated users */
  anonymousLimit: number;
  /** Requests allowed per window for authenticated users */
  authenticatedLimit: number;
  /** Window duration in seconds */
  windowSeconds: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  anonymousLimit: 10,
  authenticatedLimit: 100,
  windowSeconds: 60, // 1 minute
};

/**
 * Rate limiter that applies different limits based on authentication status
 *
 * Usage in API routes:
 * ```typescript
 * const rateLimitResult = await rateLimit(request, {
 *   anonymousLimit: 10,    // 10 requests per minute for anonymous users
 *   authenticatedLimit: 100 // 100 requests per minute for logged-in users
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

  const now = Date.now();
  const windowMs = finalConfig.windowSeconds * 1000;

  // Get or create rate limit entry
  let entry = rateLimitStore.get(identifier);

  if (!entry || now > entry.resetTime) {
    // Create new window
    entry = {
      count: 0,
      resetTime: now + windowMs,
    };
    rateLimitStore.set(identifier, entry);
  }

  // Increment request count
  entry.count++;

  // Check if limit exceeded
  if (entry.count > limit) {
    const resetInSeconds = Math.ceil((entry.resetTime - now) / 1000);

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
            "X-RateLimit-Reset": entry.resetTime.toString(),
            "Retry-After": resetInSeconds.toString(),
          },
        },
      ),
    };
  }

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

/**
 * Cleanup old entries from the rate limit store
 * Call this periodically to prevent memory leaks
 */
export function cleanupRateLimitStore(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}

// Run cleanup every 5 minutes
if (typeof setInterval !== "undefined") {
  setInterval(cleanupRateLimitStore, 5 * 60 * 1000);
}
