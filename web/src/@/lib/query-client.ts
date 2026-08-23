"use client";

import { QueryCache, QueryClient } from "@tanstack/react-query";
import {
  isRateLimitError,
  parseRateLimitInfo,
  shouldRetryConnectError,
} from "@/lib/retry";
import type { RateLimitKind, RateLimitTier } from "@/lib/retry";
import {
  RATE_LIMIT_EVENTS,
  trackRateLimitEvent,
} from "@/lib/rate-limit-analytics";

/**
 * Queries that hit a 429 and were scheduled for an automatic retry.
 *
 * Keyed by queryHash so a recovery is attributed to the query that was
 * actually limited. Entries are removed the moment the query resolves either
 * way, so this cannot grow unbounded.
 */
const pendingRateLimited = new Map<
  string,
  { kind: RateLimitKind; tier?: RateLimitTier }
>();

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

/** Minimal structural view of the QueryCache events we care about. */
interface RateLimitCacheEvent {
  type?: string;
  query?: { queryHash?: string };
  action?: { type?: string; error?: unknown };
}

/**
 * Turn "429 → silent retry → data arrived" into a measurable event.
 *
 * The per-minute path is deliberately invisible to the user, which also makes
 * it invisible to us: without this we cannot tell a quiet recovery from a user
 * who gave up. Fires at most once per limited query — the pending entry is
 * consumed on the first success and dropped on a terminal error.
 *
 * Exported for tests; production wiring is `queryCache.subscribe` below.
 */
export function handleRateLimitCacheEvent(event: RateLimitCacheEvent): void {
  try {
    if (event?.type !== "updated") return;
    const hash = event.query?.queryHash;
    if (!hash) return;
    const action = event.action;

    if (action?.type === "failed") {
      if (!isRateLimitError(action.error)) return;
      const info = parseRateLimitInfo(action.error);
      // A monthly quota is never auto-retried, so it can never auto-recover.
      if (info.kind === "monthly") return;
      pendingRateLimited.set(hash, { kind: info.kind, tier: info.tier });
      return;
    }

    if (action?.type === "success") {
      const pending = pendingRateLimited.get(hash);
      if (!pending) return;
      pendingRateLimited.delete(hash);
      trackRateLimitEvent(RATE_LIMIT_EVENTS.AUTO_RECOVERED, {
        kind: pending.kind,
        tier: pending.tier,
      });
      return;
    }

    if (action?.type === "error") {
      // Retries were exhausted — this one did not recover.
      pendingRateLimited.delete(hash);
    }
  } catch {
    // Instrumentation must never break the query pipeline.
  }
}

function makeQueryClient() {
  const queryCache = new QueryCache();
  // Browser only: the server client is per-request and never retries in a way
  // a user experiences, and a server-side subscription would leak listeners.
  if (typeof window !== "undefined") {
    queryCache.subscribe((event) =>
      handleRateLimitCacheEvent(event as unknown as RateLimitCacheEvent),
    );
  }

  return new QueryClient({
    queryCache,
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
