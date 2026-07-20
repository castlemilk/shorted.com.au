import { cache } from "react";
import {
  SHORTS_API_URL,
  buildApiUrl,
  serverFetchWithUserAgent,
  skipForBuild,
} from "~/app/actions/config";

export interface DirectoryStock {
  code: string;
  name: string;
  shortPercent: number;
  logoUrl: string | null;
  industry: string | null;
}

interface ScreenStocksJson {
  stocks?: Array<{
    stockCode?: string;
    companyName?: string;
    shortPct?: number;
    logoUrl?: string;
    industry?: string;
  }>;
  totalCount?: number;
}

const FULL_LIMIT = 4000; // covers the whole universe (~3.3k) in ONE request
const PAGE_SIZE = 200; // legacy backend cap, used only by the fallback pager

async function fetchPage(limit: number, offset: number): Promise<ScreenStocksJson> {
  const response = await serverFetchWithUserAgent(
    buildApiUrl(SHORTS_API_URL, "/shorts.v1alpha1.ShortedStocksService/ScreenStocks"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sortField: 0,
        sortDirection: 0,
        limit,
        offset,
      }),
      next: { revalidate: 3600 },
    },
  );
  if (!response.ok) throw new Error(`ScreenStocks ${response.status}`);
  return (await response.json()) as ScreenStocksJson;
}

/**
 * The full company universe for the /directory pages, via the screener MV
 * (which carries company names, industries and the minified logo icons).
 *
 * Fetched in ONE limit=4000 request — parallel 200-row paging from Vercel SSR
 * trips the Cloudflare edge rate limit on api.shorted.com.au and blanked the
 * letter pages. Until the backend cap raise (validation.go, same PR) is
 * deployed, the old backend 400s the big request; fall back to SERIAL paging
 * (sequential requests don't trip the burst limiter). Deploy-order-free.
 * Plain JSON fetch (no protobuf-es) to keep SSR light; `cache()` dedupes
 * within a render and `next.revalidate` caches the payload across renders.
 */
export const getDirectoryStocks = cache(
  async (): Promise<DirectoryStock[]> => {
    if (skipForBuild()) return [];
    let rows: NonNullable<ScreenStocksJson["stocks"]> = [];
    try {
      const all = await fetchPage(FULL_LIMIT, 0);
      rows = all.stocks ?? [];
    } catch {
      // Old backend (limit capped at 200): page serially.
      try {
        const first = await fetchPage(PAGE_SIZE, 0);
        rows = [...(first.stocks ?? [])];
        const total = first.totalCount ?? rows.length;
        for (let o = PAGE_SIZE; o < total; o += PAGE_SIZE) {
          try {
            const page = await fetchPage(PAGE_SIZE, o);
            rows.push(...(page.stocks ?? []));
          } catch {
            break; // partial is better than empty; next revalidate retries
          }
        }
      } catch (error) {
        console.error("Failed to fetch directory stocks:", error);
        return [];
      }
    }
    return rows
      .filter((s): s is Required<typeof s> => !!s.stockCode)
      .map((s) => ({
        code: s.stockCode,
        name: s.companyName || s.stockCode,
        shortPercent: s.shortPct ?? 0,
        logoUrl: s.logoUrl || null,
        industry: s.industry || null,
      }));
  },
);
