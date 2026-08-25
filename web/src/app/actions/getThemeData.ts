import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import {
  ScreenerService,
  ScreenerSortField,
  SortDirection,
} from "~/gen/shorts/v1alpha1/screener_pb";
import {
  SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "./config";
import { getTheme } from "~/@/lib/themes/registry";
import {
  buildThemeShortSeries,
  normalizeConstituentPoints,
  type ThemeSeriesPoint,
} from "~/@/lib/themes/series";

// Everything one /themes/[slug] render needs, in ONE cached unit.
//
// Deliberately mirrors getScanResults: a connect call inside unstable_cache,
// transports built on serverFetchOutsideNextCache (a bare connect POST is
// forced no-store at Vercel runtime, which THROWS inside a revalidating
// route), and a null return so the page falls back to its static editorial
// copy instead of 500ing when the backend is down.

export interface ThemeRow {
  code: string;
  name: string;
  industry: string;
  shortPct: number;
  shortPctChange4w: number;
  latestPrice: number;
  priceChange1m: number;
  daysToCover: number;
}

export interface ThemeStats {
  /** Constituents that returned live short data. */
  constituents: number;
  /** Median short interest across those constituents (%). */
  medianShortPct: number;
  /** Highest short interest in the basket. */
  mostShorted: { code: string; name: string; shortPct: number } | null;
  /** Largest 4-week INCREASE in short interest (pp). Null when none rose. */
  biggestRiser: { code: string; name: string; changePp: number } | null;
  /** How many constituents sit above 5% of issued capital sold short. */
  aboveFivePct: number;
}

export interface ThemeSnapshot {
  /** Latest ASIC data date (YYYY-MM-DD). */
  asOfDate: string;
  rows: ThemeRow[];
  stats: ThemeStats;
  /** Weekly average + min-max band. Empty when there is too little history. */
  series: ThemeSeriesPoint[];
}

// Matches /industry-intelligence's crowding window, so the two charts describe
// the same span of history for an overlapping stock.
const SERIES_PERIOD = "2y";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const value =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return Math.round(value * 100) / 100;
}

function buildStats(rows: ThemeRow[]): ThemeStats {
  const withData = rows.filter((row) => Number.isFinite(row.shortPct));
  const mostShorted = withData.reduce<ThemeRow | null>(
    (best, row) => (!best || row.shortPct > best.shortPct ? row : best),
    null,
  );
  // Only a genuine INCREASE is a "riser" — reporting the least-negative mover
  // as the biggest riser when the whole basket is covering would be a lie.
  const riser = withData.reduce<ThemeRow | null>(
    (best, row) =>
      row.shortPctChange4w > 0 &&
      (!best || row.shortPctChange4w > best.shortPctChange4w)
        ? row
        : best,
    null,
  );
  return {
    constituents: withData.length,
    medianShortPct: median(withData.map((row) => row.shortPct)),
    mostShorted: mostShorted
      ? {
          code: mostShorted.code,
          name: mostShorted.name,
          shortPct: mostShorted.shortPct,
        }
      : null,
    biggestRiser: riser
      ? {
          code: riser.code,
          name: riser.name,
          changePp: riser.shortPctChange4w,
        }
      : null,
    aboveFivePct: withData.filter((row) => row.shortPct >= 5).length,
  };
}

async function fetchThemeSnapshot(slug: string): Promise<ThemeSnapshot> {
  const theme = getTheme(slug);
  if (!theme) {
    return {
      asOfDate: "",
      rows: [],
      stats: buildStats([]),
      series: [],
    };
  }

  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const screenerClient = createClient(ScreenerService, transport);
  const marketClient = createClient(MarketService, transport);

  const tickers = theme.tickers.map((code) => code.toUpperCase());
  const inTheme = new Set(tickers);

  // Three independent reads, one round of latency. Each degrades on its own:
  // a failed series read still leaves the table and tiles, a failed date read
  // only drops the freshness line.
  const [screen, dates, seriesResponse] = await Promise.all([
    screenerClient.screenStocks({
      filters: {
        industries: [],
        hasDirectorBuys: false,
        productCodes: tickers,
      },
      sortField: ScreenerSortField.SHORT_PCT,
      sortDirection: SortDirection.DESC,
      // The basket IS the result set — no pagination, no "top N of M".
      limit: tickers.length,
      offset: 0,
    }),
    marketClient.getAvailableDates({ limit: 1, before: "" }).catch((error: unknown) => {
      console.warn(`[getThemeSnapshot] dates fetch failed for ${slug}:`, error);
      return { dates: [] as string[] };
    }),
    marketClient
      .getTopShorts({
        period: SERIES_PERIOD,
        limit: 1000,
        offset: 0,
        productCodes: tickers,
      })
      .catch((error: unknown) => {
        console.warn(`[getThemeSnapshot] series fetch failed for ${slug}:`, error);
        return null;
      }),
  ]);

  const rows: ThemeRow[] = (screen.stocks ?? []).map((s) => ({
    code: s.stockCode,
    name: s.companyName,
    industry: s.industry,
    shortPct: s.shortPct,
    shortPctChange4w: s.shortPctChange4w,
    latestPrice: s.latestPrice,
    priceChange1m: s.priceChange1m,
    daysToCover: s.daysToCover,
  }));

  // product_codes is a newer request field: a backend that predates it ignores
  // the filter and answers with the top-1000 superset (see getTopShortsByCodes).
  // Filtering to the basket here is what makes that degradation harmless.
  const constituents = (seriesResponse?.timeSeries ?? [])
    .filter((stock) => inTheme.has(stock.productCode?.toUpperCase() ?? ""))
    .map((stock) => ({
      code: stock.productCode.toUpperCase(),
      points: normalizeConstituentPoints(stock.points),
    }));

  return {
    asOfDate: dates.dates[0] ?? "",
    rows,
    stats: buildStats(rows),
    series: buildThemeShortSeries(constituents),
  };
}

/**
 * ISR-safe theme snapshot. Degrades to null (never throws) so /themes/[slug]
 * still renders its H1, blurb and cross-links when the API is unreachable; the
 * page calls bailOnEmptyRender() in that case so the empty shell is not baked
 * into the route cache for the whole revalidate window.
 */
export async function getThemeSnapshot(
  slug: string,
): Promise<ThemeSnapshot | null> {
  if (skipForBuild()) return null;
  try {
    return await unstable_cache(
      async () => {
        const snapshot = await fetchThemeSnapshot(slug);
        // Never CACHE a data-less result — throwing makes it a cache miss so
        // the next request retries instead of pinning an empty shell for an
        // hour (the getScanResults rule).
        if (snapshot.rows.length === 0) {
          throw new Error("theme returned no constituent rows");
        }
        return snapshot;
      },
      [`theme-snapshot-${slug}-v1`],
      { tags: ["shorts-data", "theme-snapshot", `theme-${slug}`], revalidate: 3600 },
    )();
  } catch (err) {
    console.error(`[getThemeSnapshot] failed for ${slug}:`, err);
    return null;
  }
}

export interface ThemeHubStat {
  slug: string;
  medianShortPct: number;
  constituents: number;
}

/**
 * One compact live stat per theme for the /themes hub.
 *
 * This is ONE screener call for every ticker in every theme (~120 codes, one
 * row each), not one call per theme — the per-theme medians are computed from
 * the single response. The 100-code server cap is respected by chunking.
 * Degrades to an empty map; the hub's cards render without stats.
 */
export async function getThemeHubStats(
  slugs: string[],
): Promise<Record<string, ThemeHubStat>> {
  if (skipForBuild()) return {};
  const key = [...slugs].sort().join(",");
  try {
    return await unstable_cache(
      async () => {
        const themes = slugs
          .map((slug) => getTheme(slug))
          .filter((theme): theme is NonNullable<typeof theme> => Boolean(theme));
        const allCodes = Array.from(
          new Set(
            themes.flatMap((theme) =>
              theme.tickers.map((code) => code.toUpperCase()),
            ),
          ),
        );
        if (allCodes.length === 0) return {};

        const transport = createConnectTransport({
          fetch: serverFetchOutsideNextCache,
          baseUrl: SHORTS_API_URL,
        });
        const screenerClient = createClient(ScreenerService, transport);

        // The API rejects >100 product codes with InvalidArgument.
        const CHUNK = 100;
        const chunks: string[][] = [];
        for (let i = 0; i < allCodes.length; i += CHUNK) {
          chunks.push(allCodes.slice(i, i + CHUNK));
        }
        const responses = await Promise.all(
          chunks.map((codes) =>
            screenerClient.screenStocks({
              filters: {
                industries: [],
                hasDirectorBuys: false,
                productCodes: codes,
              },
              sortField: ScreenerSortField.SHORT_PCT,
              sortDirection: SortDirection.DESC,
              limit: codes.length,
              offset: 0,
            }),
          ),
        );

        const shortPctByCode = new Map<string, number>();
        for (const response of responses) {
          for (const stock of response.stocks ?? []) {
            if (!Number.isFinite(stock.shortPct)) continue;
            shortPctByCode.set(stock.stockCode.toUpperCase(), stock.shortPct);
          }
        }
        if (shortPctByCode.size === 0) {
          throw new Error("theme hub stats returned no rows");
        }

        const stats: Record<string, ThemeHubStat> = {};
        for (const theme of themes) {
          const values = theme.tickers
            .map((code) => shortPctByCode.get(code.toUpperCase()))
            .filter((value): value is number => value !== undefined);
          if (values.length === 0) continue;
          stats[theme.slug] = {
            slug: theme.slug,
            medianShortPct: median(values),
            constituents: values.length,
          };
        }
        return stats;
      },
      [`theme-hub-stats-v1-${key}`],
      { tags: ["shorts-data", "theme-snapshot"], revalidate: 3600 },
    )();
  } catch (err) {
    console.error("[getThemeHubStats] failed:", err);
    return {};
  }
}
