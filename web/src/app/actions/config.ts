/**
 * Centralized configuration for server actions
 * Uses environment variables with fallbacks for different environments
 */

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
export const SHORTED_E2E_USER_AGENT = "Shorted-E2E/1.0";
export const SHORTED_TESTING_BYPASS_HEADER = "X-Shorted-Testing-Bypass";

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

  const request = getFetchRequest(input, init);
  const initWithNext = init as
    | (RequestInit & { next?: unknown })
    | undefined;
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
