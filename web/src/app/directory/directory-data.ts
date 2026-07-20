import { cache } from "react";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import type { ScreenerStock } from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  SERVER_SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "~/app/actions/config";
import { withRetryAndNotFound } from "~/app/actions/withRetry";

export interface DirectoryStock {
  code: string;
  name: string;
  shortPercent: number;
  logoUrl: string | null;
  industry: string | null;
}

const FULL_LIMIT = 4000; // covers the whole listed universe (~3.3k) in one call

function toDirectoryStock(s: ScreenerStock): DirectoryStock {
  return {
    code: s.stockCode,
    name: s.companyName || s.stockCode,
    shortPercent: s.shortPct ?? 0,
    logoUrl: s.logoUrl || null,
    industry: s.industry || null,
  };
}

// DO NOT use the shared `screenStocks` action here: its transport dispatches
// POSTs through Next's patched fetch with cache:no-store, which throws
// DynamicServerError ("Dynamic server usage: no-store fetch") inside these
// STATIC (generateStaticParams) letter routes' ISR regeneration — every regen
// failed and the pages served the empty build shell forever (root-caused via
// preview-deployment lambda logs, 2026-07-20). serverFetchOutsideNextCache
// dispatches via the unpatched fetch, sidestepping the static tracker.
const fetchDirectoryStocks = async (): Promise<DirectoryStock[]> => {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);
  const res = await client.screenStocks({
    sortField: 0,
    sortDirection: 0,
    limit: FULL_LIMIT,
    offset: 0,
  });
  return (res.stocks ?? []).map(toDirectoryStock);
};

const fetchWithRetry = withRetryAndNotFound(fetchDirectoryStocks);

/**
 * The full company universe for the /directory pages, via the screener MV
 * (company names, industries and the minified logo icons). `cache()` dedupes
 * across a single render; ISR (revalidate) caches the rendered page.
 */
export const getDirectoryStocks = cache(
  async (): Promise<DirectoryStock[]> => {
    if (skipForBuild()) return [];
    return (await fetchWithRetry()) ?? [];
  },
);
