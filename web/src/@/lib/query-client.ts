"use client";

import { QueryClient } from "@tanstack/react-query";
import {
  isRateLimitError,
  parseRateLimitInfo,
  shouldRetryConnectError,
} from "@/lib/retry";

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
      // Use server-suggested delay (in seconds, convert to ms)
      // Add a small buffer and cap at 60 seconds
      return Math.min(rateLimitInfo.retryAfter * 1000 + 500, 60000);
    }
    // Default rate limit delay: longer than normal exponential backoff
    return Math.min(5000 * 2 ** attemptIndex, 60000);
  }

  // Standard exponential backoff for other errors
  return Math.min(1000 * 2 ** attemptIndex, 30000);
}

/**
 * Determine if a query should be retried
 */
function shouldRetryQuery(
  failureCount: number,
  error: unknown
): boolean {
  // Max 3 retries
  if (failureCount >= 3) return false;

  // For rate limits, always retry (with appropriate delay)
  if (isRateLimitError(error)) {
    const rateLimitInfo = parseRateLimitInfo(error);
    // Don't retry if monthly limit is hit
    if (
      rateLimitInfo.monthlyLimit &&
      rateLimitInfo.monthlyUsed &&
      rateLimitInfo.monthlyUsed >= rateLimitInfo.monthlyLimit
    ) {
      return false;
    }
    return true;
  }

  // Use standard Connect-RPC retry logic for other errors
  return shouldRetryConnectError(error);
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Stale time of 1 minute - data is considered fresh for this duration
        staleTime: 60 * 1000,
        // Garbage collection time of 5 minutes
        gcTime: 5 * 60 * 1000,
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
