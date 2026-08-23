/**
 * GA4 instrumentation for the rate-limit experience.
 *
 * This is a conversion funnel, not debug logging:
 *
 *   rate_limit_encountered   (every classified 429, UI or not)
 *      └─ rate_limit_notice_shown  →  rate_limit_upgrade_click  (conversion)
 *      └─                          →  rate_limit_signin_click   (anon → free)
 *   rate_limit_auto_recovered                              (the quiet path)
 *   rate_limit_page_view                                   (deep-link entry)
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
 *  - **Effectively no imports.** The only runtime import is
 *    `analytics-events.ts`, itself dependency-free, so this adds ~0 to any
 *    shared chunk — which matters for the 5% first-load budget on `/`, `/top`
 *    and `/statistics`.
 *
 * Documented for the analytics side in
 * `src/@/components/rate-limit/README.md`.
 */

import type { RateLimitKind, RateLimitTier } from "./retry";
import { currentSurface, routeGroupFromPath, sendGaEvent } from "./analytics-events";

// Re-exported so the rate-limit call sites keep one import, and so the
// pre-existing public surface of this module is unchanged.
export { currentSurface, routeGroupFromPath };

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
  /**
   * A classified 429 came back on the wire — **whether or not** anything was
   * rendered. This is the denominator `notice_shown` never had: a background
   * refetch that 429s and quietly recovers produces an `encountered` and no
   * `notice_shown` at all, so before this we could not see it happen.
   *
   * `encountered` counts *requests*; `notice_shown` counts *users seeing
   * something*. One user-visible limit produces one of each, so they are not
   * duplicates of one another — but see the occurrence guard in
   * `query-client.ts`, which keeps a 3-retry burst from emitting three.
   */
  ENCOUNTERED: "rate_limit_encountered",
  /**
   * The standalone `/rate-limit` route was opened. A distinct funnel entry from
   * `notice_shown`: this arrival came from outside the app (an API error body,
   * the edge, an email), so it is the only rate-limit event that can be a
   * session's first.
   */
  PAGE_VIEW: "rate_limit_page_view",
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
 * Events that are *not* user interactions.
 *
 * Being limited, silently recovering, and landing on a page you were redirected
 * to are all things that happen *to* a user; counting them as engagement would
 * distort bounce and engagement rates. The two CTA clicks ARE interactions and
 * are deliberately absent from this set.
 */
const NON_INTERACTION_EVENTS: ReadonlySet<string> = new Set<string>([
  RATE_LIMIT_EVENTS.NOTICE_SHOWN,
  RATE_LIMIT_EVENTS.AUTO_RECOVERED,
  RATE_LIMIT_EVENTS.ENCOUNTERED,
  RATE_LIMIT_EVENTS.PAGE_VIEW,
]);

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
    const payload: Record<string, string | boolean> = {
      kind: params.kind ?? "unknown",
      tier: params.tier ?? "unknown",
      surface: params.surface ?? currentSurface(),
      non_interaction: NON_INTERACTION_EVENTS.has(name),
    };
    if (params.variant) payload.variant = params.variant;

    sendGaEvent(name, payload);
  } catch {
    // Analytics must never surface to the user or break a retry.
  }
}
