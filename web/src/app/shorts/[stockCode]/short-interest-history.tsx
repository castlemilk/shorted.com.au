import { getStockData } from "~/app/actions/getStockData";
import {
  SHORTS_API_URL,
  buildApiUrl,
  serverFetchWithUserAgent,
} from "~/app/actions/config";
import { STOCK_PAGE_CACHE_SECONDS } from "~/app/actions/stockPageCache";

interface Point {
  date: Date;
  pct: number;
}

interface HistoryStats {
  latest: Point;
  change30d: number | null;
  change90d: number | null;
  change1y: number | null;
  allTimeHigh: Point;
  allTimeLow: Point;
}

function toDate(ts: { seconds?: bigint | number } | undefined): Date | null {
  const s = ts?.seconds;
  if (typeof s === "bigint") return new Date(Number(s) * 1000);
  if (typeof s === "number") return new Date(s * 1000);
  return null;
}

function valueAtOrBefore(points: Point[], target: Date): number | null {
  // points are ascending; walk back from the end
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]!;
    if (p.date <= target) return p.pct;
  }
  return null;
}

function computeStats(points: Point[]): HistoryStats | null {
  if (points.length === 0) return null;
  const latest = points[points.length - 1]!;
  let allTimeHigh = latest;
  let allTimeLow = latest;
  for (const p of points) {
    if (p.pct > allTimeHigh.pct) allTimeHigh = p;
    if (p.pct < allTimeLow.pct) allTimeLow = p;
  }
  const daysAgo = (n: number) =>
    new Date(latest.date.getTime() - n * 24 * 60 * 60 * 1000);
  const delta = (n: number) => {
    const prev = valueAtOrBefore(points, daysAgo(n));
    return prev === null ? null : latest.pct - prev;
  };
  return {
    latest,
    change30d: delta(30),
    change90d: delta(90),
    change1y: delta(365),
    allTimeHigh,
    allTimeLow,
  };
}

/** Rank among all shorted ASX equities, from the summary-only top-shorts API. */
async function getShortRank(stockCode: string): Promise<{ rank: number; total: number } | null> {
  try {
    // trim + headers: Vercel env vars can carry trailing newlines, and the
    // Cloudflare WAF in front of api.shorted.com.au serves an HTML 500 to
    // fetches without a UA and Connect-Protocol-Version header.
    const response = await serverFetchWithUserAgent(
      buildApiUrl(
        SHORTS_API_URL,
        "/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify({ period: "max", limit: 1000, offset: 0, summaryOnly: true }),
        next: { revalidate: STOCK_PAGE_CACHE_SECONDS },
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      timeSeries?: Array<{ productCode?: string }>;
    };
    const list = data.timeSeries ?? [];
    const idx = list.findIndex((t) => t.productCode === stockCode);
    if (idx < 0) return null;
    return { rank: idx + 1, total: list.length };
  } catch {
    return null;
  }
}

function fmtDelta(d: number | null): string {
  if (d === null) return "—";
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(2)}pp`;
}

function fmtMonthYear(d: Date): string {
  return d.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
}

function trendWord(d: number | null): string {
  if (d === null) return "been stable";
  if (d > 0.5) return `risen ${d.toFixed(2)} percentage points`;
  if (d < -0.5) return `fallen ${Math.abs(d).toFixed(2)} percentage points`;
  return "been broadly stable";
}

/**
 * Server-rendered short-interest history summary + FAQ. This is the page's
 * crawlable substance: trend deltas, all-time extremes, and rank give
 * search engines and AI answer engines self-contained quotable facts that
 * the JS-rendered charts can't provide.
 *
 * No FAQPage structured data on purpose — Google restricted FAQ rich
 * results to government/health sites in 2023; visible text is what counts.
 */
export async function ShortInterestHistory({
  stockCode,
  companyName,
}: {
  stockCode: string;
  companyName: string;
}) {
  const [series, rankInfo] = await Promise.all([
    getStockData(stockCode, "max"),
    getShortRank(stockCode),
  ]);

  const points: Point[] = (series?.points ?? [])
    .map((p) => {
      const date = toDate(p.timestamp);
      return date ? { date, pct: p.shortPosition } : null;
    })
    .filter((p): p is Point => p !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const stats = computeStats(points);
  if (!stats || stats.latest.pct <= 0) return null;

  const { latest, change30d, change90d, change1y, allTimeHigh, allTimeLow } = stats;
  const firstYear = points[0]!.date.getFullYear();

  const heavily =
    latest.pct >= 10
      ? `Yes — at ${latest.pct.toFixed(2)}%, ${stockCode} is one of the most heavily shorted stocks on the ASX`
      : latest.pct >= 5
        ? `${stockCode}'s short interest of ${latest.pct.toFixed(2)}% is elevated relative to the ASX average`
        : `Not especially — ${latest.pct.toFixed(2)}% short interest is modest by ASX standards`;

  return (
    <section
      aria-label={`${stockCode} short interest history`}
      className="mb-6 rounded-lg border bg-card p-4 md:p-5"
    >
      <h2 className="text-lg md:text-xl font-semibold tracking-tight">
        {stockCode} Short Interest History
      </h2>
      <dl className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">30-day change</dt>
          <dd className="font-semibold text-base">{fmtDelta(change30d)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">90-day change</dt>
          <dd className="font-semibold text-base">{fmtDelta(change90d)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">1-year change</dt>
          <dd className="font-semibold text-base">{fmtDelta(change1y)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">All-time high</dt>
          <dd className="font-semibold text-base">
            {allTimeHigh.pct.toFixed(2)}%{" "}
            <span className="font-normal text-muted-foreground">
              ({fmtMonthYear(allTimeHigh.date)})
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">All-time low</dt>
          <dd className="font-semibold text-base">
            {allTimeLow.pct.toFixed(2)}%{" "}
            <span className="font-normal text-muted-foreground">
              ({fmtMonthYear(allTimeLow.date)})
            </span>
          </dd>
        </div>
      </dl>

      <div className="mt-6 space-y-4 text-sm md:text-base">
        <div>
          <h3 className="font-semibold">Is {stockCode} heavily shorted?</h3>
          <p className="mt-1 text-muted-foreground leading-relaxed">
            {heavily}
            {rankInfo
              ? `, ranking #${rankInfo.rank} of ${rankInfo.total} ASX securities with reported short positions`
              : ""}
            . ASIC requires positions of 0.01% of issued capital or $100,000
            (whichever is less) to be reported.
          </p>
        </div>
        <div>
          <h3 className="font-semibold">
            How has {stockCode}&apos;s short interest changed recently?
          </h3>
          <p className="mt-1 text-muted-foreground leading-relaxed">
            Over the past 30 days {companyName}&apos;s short interest has{" "}
            {trendWord(change30d)}
            {change90d !== null
              ? `, and over 90 days it has ${trendWord(change90d)}`
              : ""}
            . The current level is {latest.pct.toFixed(2)}% of shares on issue.
          </p>
        </div>
        <div>
          <h3 className="font-semibold">
            What is the highest {stockCode}&apos;s short interest has been?
          </h3>
          <p className="mt-1 text-muted-foreground leading-relaxed">
            Since {firstYear}, {companyName}&apos;s short interest peaked at{" "}
            {allTimeHigh.pct.toFixed(2)}% in {fmtMonthYear(allTimeHigh.date)} and
            bottomed at {allTimeLow.pct.toFixed(2)}% in{" "}
            {fmtMonthYear(allTimeLow.date)}.
          </p>
        </div>
        <div>
          <h3 className="font-semibold">Where does this data come from?</h3>
          <p className="mt-1 text-muted-foreground leading-relaxed">
            All figures are sourced from daily ASIC short position reports,
            published with a four trading-day (T+4) delay. Shorted aggregates
            the full history since {firstYear} — see our{" "}
            <a href="/methodology" className="underline hover:no-underline">
              methodology
            </a>
            .
          </p>
        </div>
      </div>
    </section>
  );
}
