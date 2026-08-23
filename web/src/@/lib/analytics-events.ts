/**
 * The one place that talks to `window.gtag`.
 *
 * Extracted from `rate-limit-analytics.ts` when a second event family (the
 * developer / API-key surface) needed the same guarantees. Duplicating the
 * guard would mean two places to get the safety properties wrong.
 *
 * Invariants — every caller inherits these, none may regress:
 *  - **Never throws.** Analytics must not be able to break a render or a retry.
 *  - **No-op when GA is absent** (SSR, adblocked, not yet loaded, not
 *    configured). `window.gtag` is installed by `deferred-google-analytics.tsx`
 *    on idle, so it is genuinely missing for the first seconds of a session.
 *  - **No runtime imports.** Keeps this ~0 bytes in any shared chunk, which
 *    matters for the 5% first-load budget on `/`, `/top` and `/statistics`.
 *  - **Low cardinality, no PII.** Enforced by callers: only enumerated params,
 *    route *groups* rather than paths, never a raw query string.
 */

type Gtag = (...args: unknown[]) => void;

/**
 * Resolve `window.gtag` at call time.
 *
 * Read through an index cast (as `web-vitals.ts` does) rather than a typed
 * global — these modules are imported by client components that are also pulled
 * through server rendering.
 */
function resolveGtag(): Gtag | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = (window as unknown as Record<string, unknown>).gtag;
  return typeof candidate === "function" ? (candidate as Gtag) : undefined;
}

/** Values GA4 accepts as an event parameter without further coercion. */
export type GaEventParams = Record<string, string | number | boolean>;

/**
 * Send one GA4 event. Returns nothing and cannot fail.
 *
 * Dedupe is the caller's job: "shown once per occurrence" and "clicked twice"
 * are both real, and only the call site knows which it is looking at.
 */
export function sendGaEvent(name: string, params: GaEventParams = {}): void {
  try {
    const gtag = resolveGtag();
    if (!gtag) return; // GA blocked / not yet loaded / not configured → no-op.
    gtag("event", name, params);
  } catch {
    // Analytics must never surface to the user or break a retry.
  }
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
