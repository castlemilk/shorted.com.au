import type {
  ChartBand,
  ChartLevel,
  ChartMarker,
  ChartPoint,
} from "~/@/components/charts/types";
import { formatDate } from "~/@/lib/fundamentals/format";
import { formatPrice, formatSigned } from "~/@/lib/strategies/format";
import { calculateSMA } from "~/@/lib/technical-indicators";
import type {
  StockPriceFeatures,
  StockStrategyFitRow,
} from "~/app/actions/getStockStrategyFit";

// What each strategy's chart draws, from the levels the evaluator read. Pure,
// so the level sets are unit-tested without a chart. A level whose input is
// unknown is omitted, never drawn at zero. Every level and band is on the
// LEFT (price) axis: the short-interest series of crowded-short supplies the
// right axis, and the chart places a right-axis level against a fallback
// scale when no series is on that axis.

export interface LevelSet {
  levels: ChartLevel[];
  bands: ChartBand[];
  markers: ChartMarker[];
  /** Lines under the chart, e.g. "Base 9.3% deep over 22 sessions". */
  caption: string[];
  /** Draw the short-interest series on the right axis (crowded-short). */
  showShortSeries: boolean;
  /** Moving-average lines to attempt (drawn only with a full lookback). */
  smaPeriods: number[];
}

export const LEVEL_COLORS = {
  pivot: "#f59e0b",
  base: "#3b82f6",
  sma50: "#22c55e",
  sma150: "#a855f7",
  sma200: "#ef4444",
  range: "#94a3b8",
  breakout: "#f97316",
} as const;

export const PRICE_ONLY_NOTE =
  "Levels unavailable for this stock right now; showing price only.";

const DAY = 86_400_000;
/** Sessions → calendar days; the chart clips whatever runs off the window. */
const SESSION_DAYS = 7 / 5;

/**
 * How strong each fit status is: triggered > setup > watch > none. The one
 * table the chart's default strategy and the Strategy tab's panel order both
 * read, so the two can never disagree about which strategy leads.
 */
export const FIT_STATUS_STRENGTH: Readonly<
  Record<StockStrategyFitRow["status"], number>
> = {
  triggered: 3,
  setup: 2,
  watch: 1,
  none: 0,
};

/** The strongest strategy: by status, then by score, then in the order given. */
export function defaultStrategyId(fits: StockStrategyFitRow[]): string | null {
  let best: StockStrategyFitRow | null = null;
  for (const fit of fits) {
    if (!best) {
      best = fit;
      continue;
    }
    const rank =
      FIT_STATUS_STRENGTH[fit.status] - FIT_STATUS_STRENGTH[best.status];
    if (rank > 0 || (rank === 0 && (fit.score ?? -1) > (best.score ?? -1))) {
      best = fit;
    }
  }
  return best ? best.strategyId : null;
}

function isoMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * "19 Sep" from "2026-09-19", or "" when that is not a real day. Not Intl: the
 * en-AU short month is "Sept" on Node 24 and "Sep" on other ICU builds, and a
 * label should not depend on the runtime. formatDate reads a fixed month
 * table (and rejects 31 February); the chart's own axis carries the year.
 */
function shortDay(iso: string): string {
  return formatDate(iso).replace(/\s\d{4}$/, "");
}

function level(
  value: number | null,
  label: string,
  color: string,
  extra: Partial<ChartLevel> = {},
): ChartLevel | null {
  if (value === null) return null;
  return {
    axis: "left",
    value,
    label: `${label} ${formatPrice(value)}`,
    color,
    ...extra,
  };
}

function present<T>(items: Array<T | null>): T[] {
  return items.filter((i): i is T => i !== null);
}

/** The base band, its pivot and the breakout session, each only when known. */
function baseGeometry(pf: StockPriceFeatures): {
  band: ChartBand | null;
  pivot: ChartLevel | null;
  marker: ChartMarker | null;
} {
  const { baseHigh, baseLow, baseLengthDays } = pf;
  const asOf = isoMs(pf.asOf);
  // A real day only. Date.parse rolls "2026-02-31" over into March, while
  // formatDate (behind shortDay) rejects it; the marker and the base's end both
  // go by the stricter reading, so neither is drawn at a date that does not exist.
  const breakoutDay = pf.breakoutDate ? shortDay(pf.breakoutDate) : "";
  const breakoutParsed = isoMs(pf.breakoutDate);
  const breakout = breakoutParsed !== null && breakoutDay ? breakoutParsed : null;

  // The base is anchored: after a recent breakout mv_price_features reports
  // base_high / base_low / base_length_days AS AT THE BREAKOUT SESSION (CLAUDE.md,
  // "The base is anchored"), so the base ends there. Ending it at the last close
  // would draw the band to the right of the base it describes, its length
  // counted back from a later date than the one it was measured at. Without a
  // breakout the features are as at the last close. The pivot's `to` is the
  // band's, so it never runs past the breakout either.
  const end = breakout ?? asOf;

  // The base's span needs the whole base, the date the response is as at (an
  // undated response is not drawn from) and the session the base ends on.
  // Without them there is no band, and the pivot, still a level, runs the whole
  // chart.
  let band: ChartBand | null = null;
  let span: Pick<ChartLevel, "from" | "to"> = {};
  if (
    baseHigh !== null &&
    baseLow !== null &&
    baseLengthDays !== null &&
    asOf !== null &&
    end !== null
  ) {
    const from = end - baseLengthDays * SESSION_DAYS * DAY;
    band = {
      axis: "left",
      low: baseLow,
      high: baseHigh,
      from,
      to: end,
      color: LEVEL_COLORS.base,
      label: "Base",
    };
    span = { from, to: end };
  }
  const pivot = level(baseHigh, "Pivot", LEVEL_COLORS.pivot, span);

  const marker: ChartMarker | null =
    breakout !== null
      ? {
          t: breakout,
          label: `Breakout ${breakoutDay}`,
          color: LEVEL_COLORS.breakout,
        }
      : null;
  return { band, pivot, marker };
}

function baseCaption(pf: StockPriceFeatures): string[] {
  const out: string[] = [];
  if (pf.baseDepthPct !== null && pf.baseLengthDays !== null) {
    out.push(
      `Base ${pf.baseDepthPct.toFixed(1)}% deep over ${pf.baseLengthDays} sessions`,
    );
  }
  if (pf.volumeRatio50d !== null) {
    out.push(`Volume ${pf.volumeRatio50d.toFixed(1)}× the 50-day average`);
  }
  return out;
}

export function strategyLevelSet(
  strategyId: string,
  pf: StockPriceFeatures | null,
  opts: { shortRuleDetail?: string },
): LevelSet {
  if (!pf) {
    return {
      levels: [],
      bands: [],
      markers: [],
      caption: [PRICE_ONLY_NOTE],
      showShortSeries: false,
      smaPeriods: [],
    };
  }
  const base = baseGeometry(pf);
  const sma50 = level(pf.sma50, "SMA 50", LEVEL_COLORS.sma50);
  const sma150 = level(pf.sma150, "SMA 150", LEVEL_COLORS.sma150);
  const sma200 = level(pf.sma200, "SMA 200", LEVEL_COLORS.sma200);
  const sma200Prior = level(
    pf.sma200PriorMonth,
    "SMA 200 a month ago",
    LEVEL_COLORS.sma200,
    { dash: "4,3" },
  );
  const high52 = level(pf.high52w, "52-week high", LEVEL_COLORS.range);
  const low52 = level(pf.low52w, "52-week low", LEVEL_COLORS.range);

  switch (strategyId) {
    case "zanger-breakout":
      return {
        levels: present([base.pivot]),
        bands: present([base.band]),
        markers: present([base.marker]),
        caption: baseCaption(pf),
        showShortSeries: false,
        smaPeriods: [],
      };
    case "canslim": {
      // Relative strength is the stock's return less the index's: points, not
      // a return of its own, so "pp" as the picker's table writes it.
      const rs = [
        pf.rs3mPct !== null ? `RS 3m ${formatSigned(pf.rs3mPct, "pp")}` : null,
        pf.rs6mPct !== null ? `RS 6m ${formatSigned(pf.rs6mPct, "pp")}` : null,
      ];
      return {
        levels: present([high52, base.pivot]),
        bands: present([base.band]),
        markers: present([base.marker]),
        caption: [...present(rs), ...baseCaption(pf)],
        showShortSeries: false,
        smaPeriods: [],
      };
    }
    case "minervini-trend-template":
      return {
        levels: present([sma50, sma150, sma200, sma200Prior, low52]),
        bands: [],
        markers: [],
        caption:
          pf.high52w !== null && pf.close !== null
            ? [
                `Close ${formatPrice(pf.close)} vs 52-week high ${formatPrice(pf.high52w)}`,
              ]
            : [],
        showShortSeries: false,
        smaPeriods: [50, 150, 200],
      };
    case "crowded-short-breakout": {
      // The API reports the short interest tested, not the rule's threshold,
      // so the rule's own evidence line is quoted rather than a level drawn.
      const evidence = opts.shortRuleDetail?.trim();
      return {
        levels: present([base.pivot]),
        bands: present([base.band]),
        markers: present([base.marker]),
        caption: [...(evidence ? [evidence] : []), ...baseCaption(pf)],
        showShortSeries: true,
        smaPeriods: [],
      };
    }
    case "quality-compounders":
      return {
        levels: present([sma200]),
        bands: [],
        markers: [],
        caption: [],
        showShortSeries: false,
        smaPeriods: [200],
      };
    default:
      return {
        levels: present([sma200, high52, low52]),
        bands: [],
        markers: [],
        caption: [],
        showShortSeries: false,
        smaPeriods: [200],
      };
  }
}

/** SMA values aligned to `points`; null below a full lookback, never partial. */
export function smaIndicator(
  points: ChartPoint[],
  period: number,
): (number | null)[] | null {
  if (period <= 0 || points.length < period) return null;
  const values = calculateSMA(
    points.map((p) => p.v),
    period,
  );
  return values.map((v, i) => (i < period - 1 ? null : v));
}
