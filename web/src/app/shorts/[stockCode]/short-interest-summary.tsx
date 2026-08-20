import { getStockData } from "~/app/actions/getStockData";

/**
 * Templated short-interest summary — the prose paragraph that competitors beat
 * our data-only stock pages with on "[ticker] short interest" queries.
 *
 * Deliberately factual template prose, not synthesized editorial: every clause
 * is a formatted number from data this page ALREADY fetched. `getStockData`
 * is React-cached per render and is the same series `getLatestShortDate`
 * reads, so this adds zero backend calls.
 *
 * Every clause degrades independently. A missing delta drops its sentence; a
 * missing report date falls back to "in the latest ASIC report". Nothing here
 * may ever render "undefined%" or "as of null".
 */

interface Point {
  date: Date;
  pct: number;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (typeof value === "string") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  const seconds = (value as { seconds?: bigint | number }).seconds;
  if (typeof seconds === "bigint") return new Date(Number(seconds) * 1000);
  if (typeof seconds === "number") return new Date(seconds * 1000);
  return null;
}

/** Latest value at or before `target`; null when the series doesn't reach back. */
function valueAtOrBefore(points: Point[], target: Date): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]!;
    if (p.date <= target) return p.pct;
  }
  return null;
}

export interface ShortInterestDeltas {
  change7d: number | null;
  change30d: number | null;
  change90d: number | null;
  peakPct: number | null;
  peakDate: Date | null;
}

/**
 * Percentage-point changes over trailing windows, measured from the LATEST
 * point in the series (never from `new Date()` — ASIC publishes T+4, so
 * "30 days ago" anchored on today would silently shorten every window).
 * Returns all-nulls rather than throwing when the series is unavailable.
 */
export async function getShortInterestDeltas(
  stockCode: string,
): Promise<ShortInterestDeltas> {
  const empty: ShortInterestDeltas = {
    change7d: null,
    change30d: null,
    change90d: null,
    peakPct: null,
    peakDate: null,
  };
  let series: Awaited<ReturnType<typeof getStockData>>;
  try {
    series = await getStockData(stockCode, "max");
  } catch {
    return empty;
  }

  const points: Point[] = (series?.points ?? [])
    .map((p) => {
      const date = toDate(p.timestamp);
      return date ? { date, pct: p.shortPosition } : null;
    })
    .filter((p): p is Point => p !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const latest = points[points.length - 1];
  if (!latest) return empty;

  const delta = (days: number): number | null => {
    const prev = valueAtOrBefore(
      points,
      new Date(latest.date.getTime() - days * 86400000),
    );
    // A window that resolves to the latest point itself has no history behind
    // it — reporting "0.00 pp" there would be a fabricated fact.
    if (prev === null) return null;
    return latest.pct - prev;
  };

  let peak = latest;
  for (const p of points) if (p.pct > peak.pct) peak = p;

  return {
    change7d: delta(7),
    change30d: delta(30),
    change90d: delta(90),
    peakPct: peak.pct,
    peakDate: peak.date,
  };
}

/** "+0.42 percentage points" / "0.42 percentage points" (unsigned magnitude). */
function pp(value: number): string {
  const abs = Math.abs(value);
  return `${abs.toFixed(2)} percentage point${abs === 1 ? "" : "s"}`;
}

/** Directional phrase for a delta; null when the move is inside the noise band. */
function movePhrase(value: number): string {
  if (value > 0.05) return `risen ${pp(value)}`;
  if (value < -0.05) return `fallen ${pp(value)}`;
  return "been broadly flat";
}

function fmtMonthYear(date: Date): string {
  return date.toLocaleDateString("en-AU", {
    month: "long",
    year: "numeric",
    timeZone: "Australia/Sydney",
  });
}

interface ShortInterestSummaryProps {
  stockCode: string;
  companyName: string;
  industry: string;
  shortPct: number;
  shortPositions: number;
  /** "as of 12 Aug 2026" or "in the latest ASIC report" — never a raw date. */
  asOfClause: string;
  deltas: ShortInterestDeltas;
}

export function ShortInterestSummary({
  stockCode,
  companyName,
  industry,
  shortPct,
  shortPositions,
  asOfClause,
  deltas,
}: ShortInterestSummaryProps) {
  const { change7d, change30d, change90d, peakPct, peakDate } = deltas;

  // Sentence 1 — the headline fact.
  const positions =
    shortPositions > 0
      ? new Intl.NumberFormat("en-AU").format(Math.round(shortPositions))
      : null;

  const lead =
    shortPct > 0
      ? `${companyName} (ASX:${stockCode}) has ${shortPct.toFixed(2)}% of its shares on issue reported as short positions ${asOfClause}${
          positions ? `, or about ${positions} shares` : ""
        }.`
      : `${companyName} (ASX:${stockCode}) has no reportable short positions ${asOfClause}.`;

  // Sentence 2 — recent direction. Prefer the 30-day window (the one the
  // query cluster asks about); fall back to 7-day, then 90-day.
  const primary =
    change30d !== null
      ? { days: 30, value: change30d }
      : change7d !== null
        ? { days: 7, value: change7d }
        : change90d !== null
          ? { days: 90, value: change90d }
          : null;

  const secondary =
    primary?.days === 30 && change90d !== null
      ? { days: 90, value: change90d }
      : primary?.days === 30 && change7d !== null
        ? { days: 7, value: change7d }
        : null;

  const trendSentence = primary
    ? `Over the past ${primary.days} days that figure has ${movePhrase(primary.value)}${
        secondary ? `, and over ${secondary.days} days it has ${movePhrase(secondary.value)}` : ""
      }.`
    : null;

  // Sentence 3 — historical context, only when the peak is meaningfully
  // above the current level (otherwise it restates sentence 1).
  const peakSentence =
    peakPct !== null && peakDate && shortPct > 0 && peakPct > shortPct + 0.05
      ? `Its highest recorded short interest was ${peakPct.toFixed(2)}% in ${fmtMonthYear(peakDate)}.`
      : null;

  // Sentence 4 — provenance + sector, the E-E-A-T close.
  const closing = `${
    industry ? `${stockCode} is classified in the ${industry} industry. ` : ""
  }All figures come from official ASIC short position reports, published with a four trading-day (T+4) delay.`;

  return (
    <section
      aria-label={`${stockCode} short interest summary`}
      className="mb-6 rounded-lg border bg-card px-4 py-3"
    >
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        <span className="text-foreground">{lead}</span>
        {trendSentence ? ` ${trendSentence}` : ""}
        {peakSentence ? ` ${peakSentence}` : ""}
        {` ${closing}`}
      </p>
    </section>
  );
}
