import Link from "next/link";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { formatCompanyName } from "~/@/lib/company-name";
import { latestAsicDataDate } from "~/@/components/home/asic-data-freshness";

/**
 * Auto-generated "where shorts are building / covering" prose (SEO roadmap
 * item 4). Deterministic sentences assembled from the same cached
 * getTopShortsData("1w", 50) call TrendingThisWeek makes — React cache()
 * dedups it, so this section costs no extra RPC. The point is
 * daily-changing, indexable, entity-rich text: crawlers see fresh prose with
 * stock names and internal links every visit, which is the trick the
 * strongest competitor page uses.
 *
 * Server component, no client JS. Renders nothing if the data is unusable.
 */

type Mover = {
  code: string;
  name: string;
  percent: number;
  change: number;
};

const DATE_FORMAT = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "long",
  timeZone: "Australia/Sydney",
});

function StockPhrase({ stock, verbose }: { stock: Mover; verbose: boolean }) {
  const direction = stock.change > 0 ? "up" : "down";
  const magnitude = Math.abs(stock.change).toFixed(2);
  return (
    <>
      <Link
        href={`/shorts/${stock.code}`}
        className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
      >
        {stock.name}
      </Link>{" "}
      ({stock.code}
      {verbose
        ? `, ${direction} ${magnitude} percentage points to ${stock.percent.toFixed(2)}% of shares on issue`
        : `, ${direction} ${magnitude}pp to ${stock.percent.toFixed(2)}%`}
      )
    </>
  );
}

function joinPhrases(stocks: Mover[], verbose: boolean) {
  return stocks.map((stock, i) => (
    <span key={stock.code}>
      {i > 0 && (i === stocks.length - 1 ? " and " : ", ")}
      <StockPhrase stock={stock} verbose={verbose && i === 0} />
    </span>
  ));
}

export async function ShortFlowNarrative() {
  let building: Mover[] = [];
  let covering: Mover[] = [];
  let asOf: Date | null = null;

  try {
    const data = await getTopShortsData("1w", 50, 0);
    asOf = latestAsicDataDate(data?.timeSeries);
    const movers: Mover[] = (data?.timeSeries ?? [])
      .filter((ts) => ts.latestShortPosition > 0 && ts.points.length >= 2)
      .map((ts) => {
        const first = ts.points[0];
        const last = ts.points[ts.points.length - 1];
        return {
          code: ts.productCode,
          name:
            formatCompanyName(ts.name, ts.productCode) || ts.productCode,
          percent: ts.latestShortPosition,
          change:
            first && last ? last.shortPosition - first.shortPosition : 0,
        };
      })
      .filter((s) => Math.abs(s.change) > 0.05)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    building = movers.filter((m) => m.change > 0).slice(0, 3);
    covering = movers.filter((m) => m.change < 0).slice(0, 3);
  } catch {
    return null;
  }

  // Prose with only one side reads like a data glitch; require both.
  if (building.length === 0 || covering.length === 0) return null;

  const dateline = asOf ? ` to ${DATE_FORMAT.format(asOf)}` : "";

  return (
    <section className="container mx-auto px-4 py-6">
      <h2 className="text-lg font-semibold tracking-tight">
        Where Short Sellers Are Building and Covering
      </h2>
      <div className="mt-2 max-w-3xl space-y-3 text-sm text-muted-foreground">
        <p>
          Over the past week of ASIC short position data{dateline}, short
          sellers built their largest new positions in {joinPhrases(building, true)}
          . Rising short interest signals growing bearish conviction against a
          stock among hedge funds and institutional investors.
        </p>
        <p>
          On the other side of the ledger, shorts covered most heavily in{" "}
          {joinPhrases(covering, true)}. Falling short interest can mean the
          bear case has played out — or that short sellers are locking in
          profits and reducing exposure.
        </p>
        <p>
          Track every position change in the{" "}
          <Link
            href="/screener"
            className="underline underline-offset-4 hover:text-foreground"
          >
            stock screener
          </Link>{" "}
          or browse the{" "}
          <Link
            href="/top"
            className="underline underline-offset-4 hover:text-foreground"
          >
            top 100 most shorted ASX stocks
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
