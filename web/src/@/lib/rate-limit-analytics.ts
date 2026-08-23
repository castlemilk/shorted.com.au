/**
 * GA4 instrumentation for the rate-limit experience.
 *
 * This is a conversion funnel, not debug logging:
 *
 *   rate_limit_notice_shown  →  rate_limit_upgrade_click   (paid conversion)
 *                            →  rate_limit_signin_click    (anonymous → free)
 *   rate_limit_auto_recovered                              (the quiet path)
 *
 * Design constraints, all deliberate:
 *  - **Never throws.** Every call is wrapped; analytics must not be able to
 *    break a render or the retry path.
 *  - **No-op when GA is absent.** Blocked, adblocked, not configured, or SSR →
 *    silently returns. `window.gtag` is installed by
 *    `deferred-google-analytics.tsx`, which loads on idle, so it is genuinely
 *    absent for the first seconds of a session.
 *  - **No PII, low cardinality.** Only the enumerated params below are sent.
 *    `surface` is a route *group* (`/shorts/*`), never a full path with a
 *    stock code or query string.
 *  - **No imports.** Keeping this module dependency-free (type-only imports are
 *    erased at build time) means it adds ~0 to any shared chunk, which matters
 *    for the 5% first-load budget on `/`, `/top` and `/statistics`.
 *
 * Documented for the analytics side in
 * `src/@/components/rate-limit/README.md`.
 */

import type { RateLimitKind, RateLimitTier } from "./retry";

/**
 * Canonical GA4 event names. Exported as consts so call sites and the GA4
 * config can never drift apart on a typo.
 */
export const RATE_LIMIT_EVENTS = {
  /** The user was actually shown a rate-limit notice. Top of the funnel. */
  NOTICE_SHOWN: "rate_limit_notice_shown",
  /** The upgrade CTA was used. THE conversion event. */
  UPGRADE_CLICK: "rate_limit_upgrade_click",
  /** The anonymous → sign-in CTA was used. */
  SIGNIN_CLICK: "rate_limit_signin_click",
  /** A transient limit auto-retried and succeeded — the user was never stuck. */
  AUTO_RECOVERED: "rate_limit_auto_recovered",
} as const;

export type RateLimitEventName =
  (typeof RATE_LIMIT_EVENTS)[keyof typeof RATE_LIMIT_EVENTS];

/** Where the notice was rendered. */
export type RateLimitVariant = "inline" | "page";

export interface RateLimitEventParams {
  /** Which limit was tripped. */
  kind?: RateLimitKind;
  /** Caller tier. */
  tier?: RateLimitTier;
  /** Which presentation the user saw. Absent for auto-recovery (no UI). */
  variant?: RateLimitVariant;
  /** Low-cardinality route group, e.g. `/shorts/*`. */
  surface?: string;
}

/**
 * Collapse a pathname to a low-cardinality route group.
 *
 * `/shorts/BHP` → `/shorts/*`, `/housing/nsw/bondi` → `/housing/*`, `/` → `/`.
 * Only the first segment is kept, so per-stock and per-suburb pages cannot
 * explode GA's cardinality. Anything unexpected becomes `/other`.
 */
export function routeGroupFromPath(pathname: string | null | undefined): string {
  if (typeof pathname !== "string") return "/other";
  const trimmed = pathname.split("?")[0]!.split("#")[0]!;
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const first = segments[0]!.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(first)) return "/other";
  return segments.length > 1 ? `/${first}/*` : `/${first}`;
}

/** The current route group, read from the browser. Safe on the server. */
export function currentSurface(): string {
  if (typeof window === "undefined") return "/other";
  try {
    return routeGroupFromPath(window.location?.pathname);
  } catch {
    return "/other";
  }
}

type Gtag = (...args: unknown[]) => void;

/**
 * Resolve `window.gtag` without importing anything.
 *
 * NOTE: read through an index cast (as `web-vitals.ts` does) rather than a
 * typed global — this module is imported by client components that are also
 * pulled through server rendering.
 */
function resolveGtag(): Gtag | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = (window as unknown as Record<string, unknown>).gtag;
  return typeof candidate === "function" ? (candidate as Gtag) : undefined;
}

/**
 * Send one rate-limit funnel event to GA4.
 *
 * Callers are responsible for firing once per *occurrence* (see the
 * `lastShownKey` ref in `RateLimitNotice`) — this helper does no dedupe of its
 * own, because "shown once per occurrence" and "clicked twice" are both real.
 */
export function trackRateLimitEvent(
  name: RateLimitEventName,
  params: RateLimitEventParams = {},
): void {
  try {
    const gtag = resolveGtag();
    if (!gtag) return; // GA blocked / not yet loaded / not configured → no-op.

    const payload: Record<string, string | boolean> = {
      kind: params.kind ?? "unknown",
      tier: params.tier ?? "unknown",
      surface: params.surface ?? currentSurface(),
      // Being rate limited and silently recovering are not user interactions;
      // counting them as engagement would distort bounce/engagement rates.
      // The two CTA clicks ARE interactions and are left as such.
      non_interaction:
        name === RATE_LIMIT_EVENTS.NOTICE_SHOWN ||
        name === RATE_LIMIT_EVENTS.AUTO_RECOVERED,
    };
    if (params.variant) payload.variant = params.variant;

    gtag("event", name, payload);
  } catch {
    // Analytics must never surface to the user or break a retry.
  }
}
