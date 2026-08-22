"use client";

import { QueryClient } from "@tanstack/react-query";
import {
  isRateLimitError,
  parseRateLimitInfo,
  shouldRetryConnectError,
} from "@/lib/retry";

/**
 * Longest we will make a browsing user wait for an automatic retry.
 *
 * The edge sends `Retry-After: 60` on a per-minute 429, but its buckets are
 * token/sliding rather than fixed windows, so capacity returns progressively —
 * a retry before the full window usually succeeds. Sitting silently for a full
 * minute reads as "broken"; 30s keeps the widget honest and responsive, and a
 * retry that lands early simply 429s again and re-arms the countdown.
 */
const MAX_RATE_LIMIT_RETRY_DELAY_MS = 30_000;

/**
 * Calculate retry delay, respecting Retry-After header for rate limits
 */
function calculateRetryDelay(
  attemptIndex: number,
  error: unknown
): number {
  // For rate limit errors, use the Retry-After header if available
  if (isRateLimitError(error)) {
    const rateLimitInfo = parseRateLimitInfo(error);
    if (rateLimitInfo.retryAfter) {
      // Use server-suggested delay (in seconds, convert to ms) plus a small
      // buffer so we land just after the window rather than exactly on it.
      return Math.min(
        rateLimitInfo.retryAfter * 1000 + 500,
        MAX_RATE_LIMIT_RETRY_DELAY_MS
      );
    }
    // Default rate limit delay: longer than normal exponential backoff
    return Math.min(5000 * 2 ** attemptIndex, MAX_RATE_LIMIT_RETRY_DELAY_MS);
  }

  // Standard exponential backoff for other errors
  return Math.min(1000 * 2 ** attemptIndex, 30000);
}

/**
 * Determine if a query should be retried.
 *
 * The two rate-limit cases are handled sharply differently:
 *  - per_minute (or unclassified) → retry; the window is seconds wide and the
 *    user is mid-browse, so a quiet auto-recovery is the right behaviour.
 *  - monthly → never retry. The quota does not refill until the month rolls
 *    over, so retries are pure waste and they delay the upgrade panel.
 */
function shouldRetryQuery(
  failureCount: number,
  error: unknown
): boolean {
  // Max 3 retries
  if (failureCount >= 3) return false;

  if (isRateLimitError(error)) {
    return parseRateLimitInfo(error).kind !== "monthly";
  }

  // Use standard Connect-RPC retry logic for other errors
  return shouldRetryConnectError(error);
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Stale time of 5 minutes - short position data changes at most once per day
        // (per-hook overrides in use-stock-queries.ts lengthen this for daily data).
        staleTime: 5 * 60 * 1000,
        // Retention is decoupled from freshness: keep inactive query data for 30
        // minutes so back/forward navigation and tab switches are instant instead
        // of refetching from scratch. gcTime is memory retention, NOT freshness.
        gcTime: 30 * 60 * 1000,
        // Smart retry logic with rate limit awareness
        retry: shouldRetryQuery,
        retryDelay: calculateRetryDelay,
        // Refetch on mount if data is stale
        refetchOnMount: true,
        // Don't refetch on window focus by default (can be overridden per query)
        refetchOnWindowFocus: false,
      },
      mutations: {
        // Retry mutations once (not rate limit aware - mutations are one-shot)
        retry: 1,
        retryDelay: 1000,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined = undefined;

export function getQueryClient() {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return makeQueryClient();
  } else {
    // Browser: make a new query client if we don't already have one
    // This is very important so we don't re-make a new client if React
    // suspends during the initial render
    if (!browserQueryClient) browserQueryClient = makeQueryClient();
    return browserQueryClient;
  }
}
