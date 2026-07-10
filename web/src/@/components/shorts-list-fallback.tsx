import Link from "next/link";

export interface ShortsListFallbackStock {
  code: string;
  name: string;
  percent: number;
}

interface ShortsListFallbackProps {
  stocks: ShortsListFallbackStock[];
}

/**
 * Server-rendered HTML table of the most shorted ASX stocks for /shorts.
 * Provides crawlable data rows (code, company, short interest %) while the
 * client-side dashboard (dynamic, ssr:false) hydrates on top. Follows the
 * sr-only pattern established by TopShortsFallback on the homepage.
 */
export function ShortsListFallback({ stocks }: ShortsListFallbackProps) {
  if (stocks.length === 0) return null;

  return (
    <section className="container mx-auto px-4">
      <div className="sr-only">
        <h2>Most shorted ASX stocks by short interest</h2>
        <table>
          <caption>
            Most shorted stocks on the Australian Securities Exchange, sourced
            from official ASIC short position data with a T+4 trading day
            delay.
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
          <Link href="/top">View the top 100 most shorted ASX stocks</Link>
        </p>
      </div>
    </section>
  );
}
