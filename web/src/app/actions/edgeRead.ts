import {
  normalizeApiBaseUrl,
  serverFetchWithUserAgent,
} from "./config";
import { SHORTS_DATA_CACHE_TAG } from "./stockPageCache";

type QueryValue = string | number | boolean | null | undefined;
type QueryParams = Record<string, QueryValue>;

const DEFAULT_EDGE_API_URL = "https://api.shorted.com.au";
const EDGE_READ_TIMEOUT_MS = 1500;
const EDGE_READ_REVALIDATE_SECONDS = 86400;

export interface EdgeReadOptions {
  /**
   * The data-cache window, in seconds. Defaults to a day: almost every edge
   * read is ASIC-derived and refreshed by a tag when the sync writes. A read
   * whose source changes on its own schedule (news) passes that schedule.
   */
  revalidate?: number;
}

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

/**
 * `scopeTags` name what a narrow sync expires this read by: stockCodeCacheTag
 * for a per-stock read, SHORTS_LATEST_CACHE_TAG for one built from the newest
 * snapshot, market-date / market-index for the market pages. The broad
 * shorts-data tag is always added.
 */
export async function fetchEdgeReadJson<T>(
  path: string,
  params: QueryParams = {},
  scopeTags: string[] = [],
  options: EdgeReadOptions = {},
): Promise<T | undefined> {
  const baseUrl = getEdgeReadApiUrl();
  if (!baseUrl) return undefined;

  const url = buildEdgeReadUrl(baseUrl, path, params);
  const signal = timeoutSignal(EDGE_READ_TIMEOUT_MS);
  const init: RequestInit & {
    next?: { revalidate: number; tags: string[] };
  } = {
    method: "GET",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
    // The tag is load-bearing: an untagged fetch entry lives its full 24h
    // regardless of revalidateTag/revalidatePath — it was the last layer of
    // stacked staleness keeping /top on old data for a day after every sync
    // (found 2026-08-21: page cache busted, KV flushed, edge fresh, and the
    // regen still read this entry). Every edge-read consumer is shorts-derived,
    // so a broad revalidation (tag=shorts-data) busts them all, and the scope
    // tags let a narrow sync bust only what it wrote.
    next: {
      revalidate: options.revalidate ?? EDGE_READ_REVALIDATE_SECONDS,
      // Per-snapshot tags must reach this inner fetch cache as well as any
      // outer unstable_cache; otherwise a targeted correction rereads stale
      // data here until the shared shorts-data tag is invalidated.
      tags: Array.from(new Set([SHORTS_DATA_CACHE_TAG, ...scopeTags])),
    },
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
