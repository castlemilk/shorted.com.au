import Link from "next/link";
import {
  getTopShortsData,
  getTopShortsSummary,
} from "~/app/actions/getTopShorts";
import { formatCompanyName } from "~/@/lib/company-name";
import { filterEligibleTopShorts } from "~/@/lib/top-shorts-filter";

/**
 * Server-rendered HTML table of top shorted stocks.
 * Provides crawlable content for search engines while client-side charts
 * hydrate on top via the HomeContent component.
 *
 * The table lists the top 100 (not just the visible top 10): each row is an
 * internal link + entity mention per crawl, which is how rivals that SSR
 * hundreds of rows win entity coverage. The rows come from the summary-only
 * RPC (~102KB, no sparkline points) so the extra 90 rows cost almost nothing.
 *
 * It is sr-only and renders at the FOOT of the homepage: position in the DOM
 * doesn't change what a crawler extracts, but it does change how far down the
 * first chart pixel lands on a phone. The visible heading and the ASIC "as at"
 * stamp live in `page.tsx`, directly above the charts they label.
 */
export async function TopShortsFallback() {
  let stocks: Array<{
    code: string;
    name: string;
    percent: number;
  }> = [];

  try {
    const [top10, summary] = await Promise.all([
      getTopShortsData("3m", 10, 0),
      getTopShortsSummary("3m", 120).catch(() => null),
    ]);
    // Prefer the 100-row summary; fall back to the top-10 series if the
    // summary RPC is unavailable. summaryOnly bypasses the action-layer
    // eligibility filter, so apply it here (drops ETFs/bonds).
    const rows = summary?.timeSeries?.length
      ? filterEligibleTopShorts(summary.timeSeries).slice(0, 100)
      : (top10?.timeSeries ?? []).slice(0, 10);
    stocks = rows.map((ts) => ({
      code: ts.productCode,
      name: formatCompanyName(ts.name, ts.productCode) || ts.productCode,
      percent: ts.latestShortPosition,
    }));
  } catch {
    // If fetch fails, render nothing - the client-side component will load
    return null;
  }

  if (stocks.length === 0) return null;

  return (
    <div className="sr-only">
      <table>
        <caption>
          The {stocks.length} most shorted stocks on the Australian Securities
          Exchange, ranked by short interest, sourced from official ASIC short
          position data with T+4 trading day delay.
        </caption>
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Code</th>
            <th scope="col">Company</th>
            <th scope="col">Short Interest %</th>
          </tr>
        </thead>
        <tbody>
          {stocks.map((stock, index) => (
            <tr key={stock.code}>
              <td>{index + 1}</td>
              <td>
                <Link href={`/shorts/${stock.code}`}>{stock.code}</Link>
              </td>
              <td>{stock.name}</td>
              <td>{stock.percent.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <Link href="/top">View all top 100 most shorted ASX stocks</Link>
      </p>
    </div>
  );
}
