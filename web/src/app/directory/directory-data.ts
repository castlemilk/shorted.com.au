import { cache } from "react";
import { screenStocks } from "~/app/actions/screenStocks";
import { skipForBuild } from "~/app/actions/config";
import type { ScreenerStock } from "~/gen/shorts/v1alpha1/shorts_pb";

export interface DirectoryStock {
  code: string;
  name: string;
  shortPercent: number;
  logoUrl: string | null;
  industry: string | null;
}

const FULL_LIMIT = 4000; // covers the whole universe (~3.3k) in ONE request
const PAGE_SIZE = 200; // legacy backend cap, used only by the fallback pager

function toDirectoryStock(s: ScreenerStock): DirectoryStock {
  return {
    code: s.stockCode,
    name: s.companyName || s.stockCode,
    shortPercent: s.shortPct ?? 0,
    logoUrl: s.logoUrl || null,
    industry: s.industry || null,
  };
}

/**
 * The full company universe for the /directory pages, via the screener MV
 * (company names, industries and the minified logo icons).
 *
 * Uses the `screenStocks` connect action — the exact call path that the
 * /stocks + /directory CompanyDirectory sections already use successfully in
 * prod SSR. (A previous raw-JSON implementation of this file worked locally
 * but silently returned nothing on Vercel; don't reintroduce a bespoke fetch
 * path here.)
 *
 * One limit=4000 request once the backend cap raise is deployed; until then
 * the old backend rejects it and we fall back to SERIAL 200-row pages
 * (parallel bursts trip the Cloudflare edge rate limit). Partial results beat
 * empty pages and self-heal on the next ISR revalidate.
 */
export const getDirectoryStocks = cache(
  async (): Promise<DirectoryStock[]> => {
    if (skipForBuild()) return [];
    try {
      const all = await screenStocks(undefined, 0, 0, FULL_LIMIT, 0);
      if (all?.stocks?.length) return all.stocks.map(toDirectoryStock);
    } catch {
      // fall through to paging
    }
    try {
      const first = await screenStocks(undefined, 0, 0, PAGE_SIZE, 0);
      const rows = [...(first?.stocks ?? [])];
      const total = first?.totalCount ?? rows.length;
      for (let o = PAGE_SIZE; o < total; o += PAGE_SIZE) {
        try {
          const page = await screenStocks(undefined, 0, 0, PAGE_SIZE, o);
          rows.push(...(page?.stocks ?? []));
        } catch {
          break; // partial beats empty; next revalidate retries
        }
      }
      return rows.map(toDirectoryStock);
    } catch (error) {
      console.error("Failed to fetch directory stocks:", error);
      return [];
    }
  },
);
