import Link from "next/link";
import { getTopShortsData } from "~/app/actions/getTopShorts";

type ScreenerFallbackProps = {
  /**
   * Display heading for the fallback table. Varies by preset so the
   * server-rendered content matches the preset the user landed on.
   */
  heading?: string;
};

/**
 * Server-rendered crawlable preview of screener results. Gives search
 * engines and LLMs concrete stock data on /screener instead of an empty
 * client shell. The interactive ScreenerPageClient hydrates over the
 * visible container; this block sits inside an sr-only region plus a
 * visible compact table that gets replaced once the client component
 * mounts.
 */
export async function ScreenerFallback({
  heading = "ASX stocks with the highest reported short interest",
}: ScreenerFallbackProps) {
  let stocks: Array<{
    code: string;
    name: string;
    percent: number;
    industry: string;
  }> = [];

  try {
    const data = await getTopShortsData("1m", 20, 0);
    stocks = (data?.timeSeries ?? []).slice(0, 20).map((ts) => ({
      code: ts.productCode,
      name: ts.name ?? ts.productCode,
      percent: ts.latestShortPosition,
      industry: (ts as { industry?: string }).industry ?? "",
    }));
  } catch {
    return null;
  }

  if (stocks.length === 0) return null;

  return (
    <section
      aria-label="Default screener results"
      className="container mx-auto px-4 pt-2 pb-4 max-w-7xl"
    >
      <div className="sr-only">
        <h2>{heading}</h2>
        <p>
          The following list shows the 20 most shorted ASX stocks by
          ASIC-reported short interest percentage over the past month.
          Interactive filtering, sorting, and presets are provided by the
          screener interface above. Data sourced from official ASIC short
          position reports with a T+4 trading day delay.
        </p>
        <table>
          <caption>
            Top 20 most shorted ASX stocks by ASIC-reported short interest, 1 month window.
          </caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Code</th>
              <th scope="col">Company</th>
              <th scope="col">Industry</th>
              <th scope="col">Short Interest %</th>
            </tr>
          </thead>
          <tbody>
            {stocks.map((s, i) => (
              <tr key={s.code}>
                <td>{i + 1}</td>
                <td>
                  <Link href={`/shorts/${s.code}`}>{s.code}</Link>
                </td>
                <td>{s.name}</td>
                <td>{s.industry || "—"}</td>
                <td>{s.percent.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <Link href="/top">See the full top 100 most shorted ASX stocks.</Link>
        </p>
      </div>
    </section>
  );
}
