import {
  normalizeApiBaseUrl,
  serverFetchWithUserAgent,
} from "./config";

type QueryValue = string | number | boolean | null | undefined;
type QueryParams = Record<string, QueryValue>;

const DEFAULT_EDGE_API_URL = "https://api.shorted.com.au";
const EDGE_READ_TIMEOUT_MS = 1500;
const EDGE_READ_REVALIDATE_SECONDS = 86400;

export function getEdgeReadApiUrl(): string | undefined {
  if (process.env.SHORTED_ENABLE_EDGE_READS === "false") {
    return undefined;
  }

  const explicit = normalizeApiBaseUrl(process.env.SHORTED_EDGE_API_URL);
  if (explicit) return explicit;

  const hasBypassSecret = Boolean(
    process.env.SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET ??
      process.env.TF_VAR_rate_limit_testing_bypass_secret,
  );
  const runningOnVercel = Boolean(process.env.VERCEL ?? process.env.VERCEL_ENV);

  if (runningOnVercel && hasBypassSecret) {
    return DEFAULT_EDGE_API_URL;
  }

  return undefined;
}

export function buildEdgeReadUrl(
  baseUrl: string,
  path: string,
  params: QueryParams = {},
): string {
  const url = new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function fetchEdgeReadJson<T>(
  path: string,
  params: QueryParams = {},
): Promise<T | undefined> {
  const baseUrl = getEdgeReadApiUrl();
  if (!baseUrl) return undefined;

  const url = buildEdgeReadUrl(baseUrl, path, params);
  const signal = timeoutSignal(EDGE_READ_TIMEOUT_MS);
  const init: RequestInit & { next?: { revalidate: number } } = {
    method: "GET",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
    next: { revalidate: EDGE_READ_REVALIDATE_SECONDS },
  };

  try {
    const response = await serverFetchWithUserAgent(url, init);
    if (!response.ok) return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return undefined;
    }
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined") return undefined;
  const timeout = (AbortSignal as typeof AbortSignal & {
    timeout?: (duration: number) => AbortSignal;
  }).timeout;
  return typeof timeout === "function" ? timeout(ms) : undefined;
}
