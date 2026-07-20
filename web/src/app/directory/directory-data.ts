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

const PAGE_SIZE = 200; // ScreenStocks hard-caps limit at 200 (250+ returns empty)

async function fetchPage(offset: number): Promise<ScreenStocksJson> {
  const response = await serverFetchWithUserAgent(
    buildApiUrl(SHORTS_API_URL, "/shorts.v1alpha1.ShortedStocksService/ScreenStocks"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sortField: 0,
        sortDirection: 0,
        limit: PAGE_SIZE,
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
 * Paged at the API's 200-row cap: first page discovers totalCount, the rest
 * fetch in parallel. Plain JSON fetch (no protobuf-es) to keep SSR light;
 * `cache()` dedupes across a single render.
 */
export const getDirectoryStocks = cache(
  async (): Promise<DirectoryStock[]> => {
    if (skipForBuild()) return [];
    try {
      const first = await fetchPage(0);
      const total = first.totalCount ?? first.stocks?.length ?? 0;
      const pages = [first];
      if (total > PAGE_SIZE) {
        const offsets = [];
        for (let o = PAGE_SIZE; o < total; o += PAGE_SIZE) offsets.push(o);
        const rest = await Promise.all(
          offsets.map((o) => fetchPage(o).catch(() => ({ stocks: [] }))),
        );
        pages.push(...rest);
      }
      return pages
        .flatMap((p) => p.stocks ?? [])
        .filter((s): s is Required<typeof s> => !!s.stockCode)
        .map((s) => ({
          code: s.stockCode,
          name: s.companyName || s.stockCode,
          shortPercent: s.shortPct ?? 0,
          logoUrl: s.logoUrl || null,
          industry: s.industry || null,
        }));
    } catch (error) {
      console.error("Failed to fetch directory stocks:", error);
      return [];
    }
  },
);
