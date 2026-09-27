import { cache } from "react";
import { getDailyShortSeries, reportDate } from "./getDailyShortSeries";

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
 * Read from the daily series, not getStockData's "max": that one is bucketed
 * into weeks, and its last point is dated the Monday the week began, so a page
 * rendered on a Thursday report claimed to be "as of" Monday. The daily series
 * is the one the page's summary and history figures read, React-cached per
 * request, so the page makes the call once. Returns null when no dated point
 * exists: callers must degrade to omitting the date rather than inventing one.
 */
export const getLatestShortDate = cache(
  async (productCode: string): Promise<Date | null> => {
    const series = await getDailyShortSeries(productCode);
    const latest = series[series.length - 1];
    return latest ? reportDate(latest) : null;
  },
);
