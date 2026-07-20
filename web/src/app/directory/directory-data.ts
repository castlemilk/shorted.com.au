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

const PAGE_SIZE = 200; // proven request shape (screener UI); see note below

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
    // Serial 200-row pages ONLY. The single limit=4000 call succeeds via curl
    // from anywhere but its ~820KB response never materialises inside the
    // Vercel lambda (page regens rendered empty while the 48-row index call
    // worked on the same deployment). 200-row calls are the screener UI's
    // daily-proven request shape. Serial, not parallel: bursts trip the
    // Cloudflare edge rate limit.
    const first = await screenStocks(undefined, 2, 0, PAGE_SIZE, 0);
    if (!first?.stocks?.length) {
      console.error("[directory] first screener page empty/undefined");
      return [];
    }
    // PROBE B: single page only — isolating whether multi-call regen wall-time
    // is what kills the ISR revalidation.
    return first.stocks.map(toDirectoryStock);
  },
);
