import Link from "next/link";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { sectionTitle } from "~/@/lib/typography";
import {
  AsicDataFreshness,
  latestAsicDataDate,
} from "~/@/components/home/asic-data-freshness";

/**
 * Server-rendered HTML table of top shorted stocks.
 * Provides crawlable content for search engines while client-side charts
 * hydrate on top via the HomeContent component.
 */
export async function TopShortsFallback() {
  let stocks: Array<{
    code: string;
    name: string;
    percent: number;
  }> = [];
  let asOf: Date | null = null;

  try {
    const data = await getTopShortsData("3m", 10, 0);
    asOf = latestAsicDataDate(data?.timeSeries);
    stocks = (data?.timeSeries ?? [])
      .slice(0, 10)
      .map((ts) => ({
        code: ts.productCode,
        name: ts.name || ts.productCode,
        percent: ts.latestShortPosition,
      }));
  } catch {
    // If fetch fails, render nothing - the client-side component will load
    return null;
  }

  if (stocks.length === 0) return null;

  return (
    <section className="container mx-auto px-4 py-4">
      {/* The one H2 for the top-10 table. Previously rendered twice (a
          <noscript> copy plus an sr-only copy), which put a duplicate heading
          in the crawled HTML. */}
      <h2 className={sectionTitle}>Top 10 Most Shorted ASX Stocks</h2>
      <AsicDataFreshness
        date={asOf}
        className="mt-1 text-sm text-muted-foreground"
      />
      <div className="sr-only">
        <table>
          <caption>
            Most shorted stocks on the Australian Securities Exchange, sourced from
            official ASIC short position data with T+4 trading day delay.
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
    </section>
  );
}
