/**
 * Centralized configuration for server actions
 * Uses environment variables with fallbacks for different environments
 */
import { unstable_noStore } from "next/cache";

export function normalizeApiBaseUrl(
  value: string | undefined,
): string | undefined {
  const compact = value?.trim().replace(/\s+/g, "");
  if (!compact) return undefined;
  return compact.replace(/\/+$/, "");
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = normalizeApiBaseUrl(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function isVercelEnvironment(): boolean {
  return Boolean(process.env.VERCEL ?? process.env.VERCEL_ENV ?? process.env.VERCEL_REGION);
}

// SKIP_STATIC_GENERATION is set project-wide on Vercel so prerenders never
// block builds — but it is present at RUNTIME too. Data fetching must only be
// skipped during the actual `next build` phase, never for live requests or ISR
// regenerations. Checking the raw env var alone permanently blanks ISR pages
// (this exact bug emptied the sitemap, /directory and /market on prod).
export function skipForBuild(): boolean {
  return (
    process.env.SKIP_STATIC_GENERATION === "1" &&
    process.env.NEXT_PHASE === "phase-production-build"
  );
}

/**
 * Mark the CURRENT render uncacheable — call from a static-ISR page exactly
 * when it is about to render its data-empty fallback. Without this, a single
 * failed fetch during a regeneration (e.g. a cold Cloud Run right after a
 * deploy, min-instances=0) bakes the "data is loading" shell into the route
 * cache for the FULL revalidate window. With it, the empty render is served
 * once, uncached, so the very next request retries; a background revalidation
 * that comes up empty bails out and keeps serving the previous good page.
 *
 * No-ops during the production build: the deliberately-empty skipForBuild
 * prerender must keep the route STATIC (the post-deploy warm-cache call fills
 * it) — calling noStore at build time would flip the whole route to dynamic
 * and undo the ISR optimization.
 */
export function bailOnEmptyRender(): void {
  if (skipForBuild()) return;
  unstable_noStore();
}

export function buildApiUrl(baseUrl: string, path: string): string {
  const normalizedBase = normalizeApiBaseUrl(baseUrl);
  if (!normalizedBase) {
    throw new Error("Cannot build API URL without a base URL");
  }
  return new URL(path.replace(/^\/+/, ""), `${normalizedBase}/`).toString();
}

// Browser-facing config. Browser calls should normally use relative URLs so
// they flow through Next.js rewrites; this is only for public configuration.
export function getPublicShortsApiUrl(): string {
  return (
    firstNonEmpty(
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT,
      process.env.NEXT_PUBLIC_API_URL,
    ) ?? "http://localhost:9091"
  );
}

// Server-side actions should use the direct Cloud Run endpoint when available.
// The public api.shorted.com.au hostname sits behind Cloudflare bot challenges,
// which can block Vercel SSR fetches before they reach the Worker.
export function getServerShortsApiUrl(): string {
  return (
    firstNonEmpty(
      process.env.SHORTS_SERVICE_ENDPOINT,
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT,
      process.env.SHORTS_API_URL,
      process.env.NEXT_PUBLIC_API_URL,
    ) ?? (isVercelEnvironment() ? "https://api.shorted.com.au" : "http://localhost:9091")
  );
}

// Legacy server-action alias. Keep the export name because many server
// actions already import it, but make it safe by construction for SSR/builds.
export function getShortsApiUrl(): string {
  return getServerShortsApiUrl();
}

// Get the Market Data API URL with proper fallbacks
export function getMarketDataApiUrl(): string {
  return (
    firstNonEmpty(
      process.env.NEXT_PUBLIC_MARKET_DATA_API_URL,
      process.env.NEXT_PUBLIC_MARKET_DATA_URL,
      process.env.MARKET_DATA_API_URL,
      process.env.MARKET_DATA_URL,
    ) ?? "http://localhost:8090"
  );
}

// Server-side market data callers should use the direct service endpoint when
// available. The public API hostname can sit behind Cloudflare challenges and
// adds an avoidable edge hop for Vercel API routes.
export function getServerMarketDataApiUrl(): string {
  return (
    firstNonEmpty(
      process.env.MARKET_DATA_API_URL,
      process.env.MARKET_DATA_URL,
      process.env.NEXT_PUBLIC_MARKET_DATA_API_URL,
      process.env.NEXT_PUBLIC_MARKET_DATA_URL,
    ) ?? "http://localhost:8090"
  );
}

// Export for convenience
export const SHORTS_API_URL = getShortsApiUrl();
export const SERVER_SHORTS_API_URL = getServerShortsApiUrl();
export const PUBLIC_SHORTS_API_URL = getPublicShortsApiUrl();
export const MARKET_DATA_API_URL = getMarketDataApiUrl();
export const SERVER_MARKET_DATA_API_URL = getServerMarketDataApiUrl();

export const SHORTED_SSR_USER_AGENT =
  "shorted-web-ssr/1.0 (+https://shorted.com.au)";
// The substring the Cloudflare SSR-bypass rule matches on
// (terraform var rate_limit_ssr_bypass_user_agent).
export const SHORTED_SSR_USER_AGENT_MARKER = "shorted-web-ssr";
export const SHORTED_E2E_USER_AGENT = "Shorted-E2E/1.0";
export const SHORTED_TESTING_BYPASS_HEADER = "X-Shorted-Testing-Bypass";
// Paired with the shorted-web-ssr UA marker, this header exempts our OWN
// Vercel SSR fetcher from the Cloudflare zone rate limit (Vercel egress shares
// IPs per region, so ISR regenerations and warm-cache bursts trip the 60/10s
// per-IP ceiling). Server-held only — never NEXT_PUBLIC, never sent to a host
// that is not the shorted API origin.
export const SHORTED_SSR_BYPASS_HEADER = "X-Shorted-Ssr-Bypass";

function hostnameOf(value: string | undefined): string | undefined {
  const normalized = normalizeApiBaseUrl(value);
  if (!normalized) return undefined;
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

// Hosts the SSR bypass secret may be attached to. Recomputed per call so a
// changed env (tests, preview envs) is respected.
function shortedApiHostnames(): Set<string> {
  const hosts = new Set<string>(["api.shorted.com.au"]);
  for (const candidate of [
    process.env.SHORTED_EDGE_API_URL,
    process.env.SHORTS_SERVICE_ENDPOINT,
    process.env.SHORTS_API_URL,
    process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT,
    process.env.NEXT_PUBLIC_API_URL,
  ]) {
    const host = hostnameOf(candidate);
    if (host) hosts.add(host);
  }
  return hosts;
}

/** True when the request targets a shorted-owned API origin. */
export function isShortedApiRequestUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return shortedApiHostnames().has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function resolveRequestUrl(
  input: Parameters<typeof fetch>[0],
): string | undefined {
  if (typeof input === "string") return input.trim().replace(/\s+/g, "");
  if (typeof URL !== "undefined" && input instanceof URL) {
    return input.toString();
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "url" in input &&
    typeof (input as { url: unknown }).url === "string"
  ) {
    return (input as { url: string }).url;
  }
  return undefined;
}

// Next patches globalThis.fetch and stashes the original on the patched
// function (patch-fetch.js: `patched._nextOriginalFetch = originFetch`).
// Resolved lazily — the patch may land after this module evaluates.
// Returns null when fetch IS patched but the private stash is missing
// (a Next upgrade renamed it) so callers can fall back to the guarded
// path instead of silently dispatching through the patch.
let warnedMissingOriginalFetch = false;
function getUnpatchedFetch(): typeof fetch | null {
  const patched = globalThis.fetch as typeof fetch & {
    __nextPatched?: boolean;
    _nextOriginalFetch?: typeof fetch;
  };
  if (patched._nextOriginalFetch) return patched._nextOriginalFetch;
  // Not patched at all (tests, plain node) — the global fetch IS original.
  if (!patched.__nextPatched) return globalThis.fetch;
  if (!warnedMissingOriginalFetch) {
    warnedMissingOriginalFetch = true;
    console.warn(
      "[config] Next's patched fetch no longer exposes _nextOriginalFetch — " +
        "connect transports fall back to the guarded path (ISR renders may " +
        "degrade); update serverFetchOutsideNextCache for this Next version.",
    );
  }
  return null;
}

/**
 * Fetch for connect transports whose RESULTS are cached at the
 * unstable_cache layer (getStock/getStockDetails/getStockData, stock
 * headlines, industry-intelligence snapshot, statistics, scans).
 *
 * Next's patched fetch is pure hazard for these calls — there is no safe
 * option for a streamed connect POST inside a statically-generated render:
 *  - `cache: "no-store"` (what serverFetchWithUserAgent forces at Vercel
 *    runtime) throws DynamicServerError during static/ISR generation, even
 *    inside unstable_cache callbacks — this 500'd the on-demand ISR stock
 *    pages until every transport moved off the patched fetch;
 *  - default options make Next try to key the streamed POST body for the
 *    data cache ("Failed to generate cache key").
 * Bypassing the patch is correct because unstable_cache provides the
 * caching; the network call itself must be plain and uninstrumented.
 */
export const serverFetchOutsideNextCache: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    // Marker consumed below: route through the unpatched fetch.
    __shortedBypassNextFetchPatch: true,
  } as RequestInit);

/**
 * Shout, once per process, when we are about to send first-party traffic to a
 * shorted API origin WITHOUT the bypass secret.
 *
 * THIS IS THE ALARM THE AUGUST 2026 INCIDENT DID NOT HAVE. The production
 * prerender ran for days sending `shorted-web-ssr` with no secret, collected
 * ~3,500 Cloudflare 429s a day, and degraded silently to fallback data —
 * invisible until someone queried the Cloudflare GraphQL API by hand. The cause
 * was mundane and entirely detectable from inside the process: the CI-side
 * `vercel build` cannot read Vercel's SENSITIVE environment variables, so
 * `SHORTED_SSR_BYPASS_SECRET` simply was not there.
 *
 * A missing secret is no longer dangerous at the edge (unverified first-party
 * now lands in the generous runaway bucket, see
 * services/edge-worker/worker.js), but it still means our traffic is riding the
 * fallback path instead of skipping limits outright — so it must be visible in
 * a build log and a function log, not inferred from a dashboard.
 *
 * Deliberately NOT a throw: a build that renders slightly-degraded pages is
 * strictly better than a build that fails. Deliberately once-per-process: a
 * prerender makes thousands of these calls.
 */
let warnedMissingSsrBypassSecret = false;
function warnMissingSsrBypassSecret(): void {
  if (warnedMissingSsrBypassSecret) return;
  // Local dev talks to localhost and has no Cloudflare in front of it.
  if (!isVercelEnvironment() && process.env.CI !== "true") return;
  warnedMissingSsrBypassSecret = true;
  console.error(
    "[config] SHORTED_SSR_BYPASS_SECRET is not set, but this process is " +
      "sending first-party requests to a shorted API origin. Those requests " +
      "cannot be verified at the Cloudflare edge and will not skip the zone " +
      "rate limit. If this is a CI-side `vercel build`, pass the secret " +
      "explicitly (Vercel SENSITIVE env vars are not readable by `vercel " +
      "build`); if this is a Vercel runtime, the variable is missing from the " +
      "deployment. See CLAUDE.md > Cloudflare SSR Bypass.",
  );
}

export const serverFetchWithUserAgent: typeof fetch = (input, init) => {
  const headers = new Headers();
  const copyHeaders = (source?: HeadersInit) => {
    if (!source) return;
    if (typeof (source as Headers).forEach === "function") {
      (source as Headers).forEach((value, key) => {
        headers.set(key, value);
      });
      return;
    }
    new Headers(source).forEach((value, key) => {
      headers.set(key, value);
    });
  };
  if (typeof input === "object" && input !== null && "headers" in input) {
    copyHeaders(input.headers);
  }
  if (typeof Request !== "undefined") {
    try {
      copyHeaders(new Request(input).headers);
    } catch {
      // Some RequestInfo variants cannot be re-wrapped. In those cases there
      // are no useful input headers to preserve.
    }
  }
  copyHeaders(init?.headers);
  const bypassSecret = firstNonEmpty(
    process.env.SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET,
    process.env.TF_VAR_rate_limit_testing_bypass_secret,
  );
  if (bypassSecret) {
    headers.set(SHORTED_TESTING_BYPASS_HEADER, bypassSecret);
    const userAgent = headers.get("User-Agent");
    headers.set(
      "User-Agent",
      userAgent?.includes("Shorted-E2E")
        ? userAgent
        : `${userAgent ?? SHORTED_SSR_USER_AGENT} ${SHORTED_E2E_USER_AGENT}`,
    );
  } else if (!headers.has("User-Agent")) {
    headers.set("User-Agent", SHORTED_SSR_USER_AGENT);
  }

  // First-party SSR bypass for the Cloudflare zone rate limit. Attached only
  // when the secret is configured (server-only env) AND the request targets a
  // shorted API origin — the secret must never leak to a third-party host.
  const ssrBypassSecret = process.env.SHORTED_SSR_BYPASS_SECRET?.trim();
  const targetsShortedApi = isShortedApiRequestUrl(resolveRequestUrl(input));
  if (ssrBypassSecret && targetsShortedApi) {
    headers.set(SHORTED_SSR_BYPASS_HEADER, ssrBypassSecret);
    const userAgent = headers.get("User-Agent") ?? SHORTED_SSR_USER_AGENT;
    headers.set(
      "User-Agent",
      userAgent.includes(SHORTED_SSR_USER_AGENT_MARKER)
        ? userAgent
        : `${userAgent} ${SHORTED_SSR_USER_AGENT}`,
    );
  } else if (targetsShortedApi) {
    warnMissingSsrBypassSecret();
  }

  const request = getFetchRequest(input, init);
  const initWithNext = init as
    | (RequestInit & {
        next?: unknown;
        __shortedBypassNextFetchPatch?: boolean;
      })
    | undefined;

  // serverFetchOutsideNextCache marker: skip Next's patched fetch entirely
  // (see its doc comment). Strip the marker before dispatch. When the
  // original fetch can't be resolved (Next internals changed), fall through
  // to the guarded path below rather than dispatching an unguarded POST
  // through the patch.
  if (initWithNext?.__shortedBypassNextFetchPatch) {
    const { __shortedBypassNextFetchPatch: _ignored, ...cleanInit } =
      initWithNext;
    const unpatched = getUnpatchedFetch();
    if (unpatched) {
      return unpatched(normalizeFetchInput(input), {
        ...cleanInit,
        headers,
      });
    }
    init = cleanInit as RequestInit;
  }

  const method =
    init?.method ??
    (typeof input === "object" &&
    input !== null &&
    "method" in input &&
    typeof input.method === "string"
      ? input.method
      : request?.method) ??
    "GET";
  const shouldDisableFetchCache =
    isVercelRuntimeExecution() &&
    method.toUpperCase() !== "GET" &&
    method.toUpperCase() !== "HEAD" &&
    init?.cache === undefined &&
    initWithNext?.next === undefined;

  return fetch(normalizeFetchInput(input), {
    ...init,
    headers,
    ...(shouldDisableFetchCache ? { cache: "no-store" as RequestCache } : {}),
  });
};

function normalizeFetchInput(input: Parameters<typeof fetch>[0]) {
  if (typeof input === "string") {
    return input.trim().replace(/\s+/g, "");
  }

  if (typeof URL !== "undefined" && input instanceof URL) {
    return new URL(input.toString().trim().replace(/\s+/g, ""));
  }

  if (typeof Request !== "undefined" && input instanceof Request) {
    const normalizedUrl = input.url.trim().replace(/\s+/g, "");
    if (normalizedUrl !== input.url) {
      return new Request(normalizedUrl, input);
    }
  }

  return input;
}

function getFetchRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Request | null {
  if (typeof Request === "undefined") return null;
  if (input instanceof Request && init === undefined) return input;
  try {
    return new Request(input, init);
  } catch {
    return null;
  }
}

function isVercelRuntimeExecution(): boolean {
  if (process.env.SHORTED_DISABLE_CONNECT_FETCH_CACHE === "true") {
    return true;
  }
  return Boolean(
    process.env.VERCEL_REGION ?? process.env.AWS_LAMBDA_FUNCTION_NAME,
  );
}

// Log URLs in development
if (process.env.NODE_ENV === "development") {
  console.log("Server Action API URLs:", {
    shorts: SHORTS_API_URL,
    serverShorts: SERVER_SHORTS_API_URL,
    publicShorts: PUBLIC_SHORTS_API_URL,
    marketData: MARKET_DATA_API_URL,
    serverMarketData: SERVER_MARKET_DATA_API_URL,
  });
}
