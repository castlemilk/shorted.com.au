import { cache } from "react";
import { getStockData } from "./getStockData";

/**
 * The date of the most recent ASIC short-position report that actually
 * contains this stock.
 *
 * Why this exists: the stock page used to print `new Date()` as its "as of"
 * date, in the title, the description, the OG card and the crawlable summary.
 * ASIC publishes with a four trading-day delay, so a page claiming today's
 * date is claiming a report that cannot exist yet — visible on every one of
 * ~1,600 indexed stock pages, and the kind of factual error that costs
 * E-E-A-T on a data site.
 *
 * Reads the SAME cached series the page already renders (getStockData is
 * unstable_cache-backed and ISR-safe, and React-cached per request), so this
 * adds no backend call on any page that also renders the history block.
 * Returns null when no dated point exists — callers must degrade to omitting
 * the date rather than inventing one.
 */
export const getLatestShortDate = cache(
  async (productCode: string): Promise<Date | null> => {
    const series = await getStockData(productCode, "max");
    let latest = 0;
    for (const point of series?.points ?? []) {
      const ms = timestampToMillis(point?.timestamp);
      if (ms !== null && ms > latest) latest = ms;
    }
    return latest > 0 ? new Date(latest) : null;
  },
);

/**
 * Points arrive either as protobuf Timestamps ({seconds, nanos}, seconds a
 * bigint over the wire) or as ISO strings when the edge-read JSON path served
 * the response — handle both.
 */
function timestampToMillis(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === "string") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "object" && "seconds" in value) {
    const { seconds, nanos } = value as {
      seconds?: bigint | number | string;
      nanos?: number;
    };
    const secs = Number(seconds ?? 0);
    if (!Number.isFinite(secs) || secs <= 0) return null;
    return secs * 1000 + Number(nanos ?? 0) / 1_000_000;
  }
  return null;
}
