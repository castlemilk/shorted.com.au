import Link from "next/link";

import { cn } from "~/@/lib/utils";
import {
  NOT_AVAILABLE,
  NOT_MEANINGFUL,
  basisDescription,
  formatAmount,
  formatDate,
  formatGrowthPct,
  formatMultiple,
  formatPct,
  ratioOrNotMeaningful,
  sourceLabel,
  valuationNotAvailable,
  type FormattedValue,
} from "~/@/lib/fundamentals/format";
import { pickSortDef, type PickSortKey } from "~/@/lib/strategies/sort";
import type { PickFundamentalsView, PickRow } from "~/@/lib/strategies/types";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import {
  growthFigures,
  type GrowthFigure,
} from "~/@/components/stocks/growth-figures";
import { ProvenanceMark } from "~/@/components/stocks/provenance";

/**
 * A picks row's fundamentals (docs/plans/fundamentals-coverage.md §7.2): the
 * growth cells with their basis and filing mark, the native <details>
 * disclosure in the Stock cell, and the value cell of an added "Sorted by"
 * column.
 *
 * Props-only and hook-free, like the table: they render in the ISR HTML and
 * inside the sort island alike. The vocabulary is lib/fundamentals/format.ts,
 * and the growth figures are the stock page's own growthFigures(), so a figure
 * reads the same on /picks and on /shorts/<code>.
 */

/** The row source the filing mark stands for. */
export const FILING_SOURCE = "asx-filing-extraction";

type GrowthInput = Parameters<typeof growthFigures>[0];

/**
 * The two growth figures exactly as the stock page states them. The row
 * carries a basis only for a figure the API computed (and only from an API
 * that sends StrategyPick.fundamentals); a figure without one shows no basis
 * tag and no period, never growthFigures' "an empty revenue basis reads FY"
 * default, which describes an older stock-page API, not this one.
 */
export function pickGrowthFigures(row: PickRow): [GrowthFigure, GrowthFigure] {
  const f = row.fundamentals;
  const input: GrowthInput = {
    basisPeriodType: f?.epsBasis ?? "",
    latestPeriodEnd: f?.epsEnd ?? "",
    revenueBasisPeriodType: f?.revenueBasis ?? "",
    revenueYoyPct: row.revenueYoyPct,
    revenueYoyPriorPct: null,
    epsYoyPct: row.epsYoyPct,
    epsYoyPriorPct: null,
    netIncomePositive: false,
    periodsAvailable: 0,
    revenueTtm: null,
    netIncomeTtm: null,
    epsTtm: null,
    revenueHalfYoyPct: null,
    epsHalfYoyPct: null,
    halfLatestPeriodEnd: "",
    revenueBasisSource: f?.revenueFiling ? "filing" : "",
    epsBasisSource: f?.epsFiling ? "filing" : "",
    fetchedAt: "",
    revenueLatestPeriodEnd: f?.revenueEnd ?? "",
    revenuePriorPeriodEnd: "",
  };
  const [revenue, eps] = growthFigures(input) as [GrowthFigure, GrowthFigure];
  return [
    f?.revenueBasis ? revenue : withoutBasis(revenue, row.revenueYoyPct),
    f?.epsBasis ? eps : withoutBasis(eps, row.epsYoyPct),
  ];
}

function withoutBasis(
  figure: GrowthFigure,
  value: number | null,
): GrowthFigure {
  return { ...figure, basis: "", title: formatGrowthPct(value).title ?? "" };
}

/** True when any growth cell of these rows carries the filing mark. */
export function rowsShowFilingMark(rows: readonly PickRow[]): boolean {
  return rows.some((row) =>
    pickGrowthFigures(row).some((figure) => figure.fromFiling),
  );
}

function isMuted(text: string): boolean {
  return (
    text === NOT_AVAILABLE ||
    text === NOT_MEANINGFUL ||
    text.startsWith(`${NOT_AVAILABLE} `)
  );
}

/** One growth figure as a table cell's content: value, basis tag, filing mark. */
export function GrowthCellValue({ figure }: { figure: GrowthFigure }) {
  return (
    <span className="inline-flex items-baseline justify-end gap-1">
      <span
        className={isMuted(figure.text) ? "text-muted-foreground" : undefined}
      >
        {figure.text}
      </span>
      {figure.basis ? (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {figure.basis}
        </span>
      ) : null}
      {figure.fromFiling ? <ProvenanceMark source={FILING_SOURCE} /> : null}
    </span>
  );
}

function asFormatted(value: string | FormattedValue): FormattedValue {
  return typeof value === "string" ? { text: value } : value;
}

/** P/E: the multiple, or why it is absent when the reason is known. */
function peValue(f: PickFundamentalsView): FormattedValue | null {
  if (f.peRatio !== undefined) return { text: formatMultiple(f.peRatio) };
  // P/E is computed for AUD reporters only (contract §5.3): a non-AUD
  // reporter's absence has a reason worth printing.
  if (f.currency) return { text: valuationNotAvailable(f.currency, "non-aud") };
  return null;
}

interface RatioLine {
  label: string;
  /** Tooltip on the label: the definition. */
  title: string;
  value: FormattedValue;
}

/**
 * The ratios the row carries, in a fixed order: a value when held, "n/m"
 * when the API withheld it as not meaningful (a financial), P/E's "n/a
 * (reports in USD)" for a non-AUD reporter. A ratio simply not held is left
 * out: the disclosure lists what we have, and the table's "n/a" already
 * covers the rest.
 */
export function pickRatioLines(f: PickFundamentalsView): RatioLine[] {
  const nm = f.notMeaningful;
  const lines: RatioLine[] = [];
  const add = (
    label: string,
    title: string,
    name: string,
    value: number | undefined,
    fmt: (value: number | null | undefined) => string,
  ) => {
    const formatted = asFormatted(ratioOrNotMeaningful(name, value, nm, fmt));
    if (value !== undefined || formatted.text === NOT_MEANINGFUL) {
      lines.push({ label, title, value: formatted });
    }
  };
  add(
    "Net margin",
    "Net profit as a share of revenue, same period",
    "net_margin_pct",
    f.netMarginPct,
    formatPct,
  );
  add(
    "ROE",
    "Return on equity: net profit over average shareholders' equity",
    "roe_pct",
    f.roePct,
    formatPct,
  );
  add(
    "FCF margin",
    "Free cash flow (operating cash flow less capex) as a share of revenue",
    "fcf_margin_pct",
    f.fcfMarginPct,
    formatPct,
  );
  add(
    "Net debt / EBITDA",
    "Net debt excluding lease liabilities over EBITDA (normalised when published); negative means net cash",
    "net_debt_to_ebitda",
    f.netDebtToEbitda,
    formatMultiple,
  );
  const pe = peValue(f);
  if (pe) {
    lines.push({
      label: "P/E",
      title: "Latest close over 12-month earnings per share",
      value: pe,
    });
  }
  return lines;
}

function basisLine(
  basis: string | undefined,
  end: string | undefined,
  filing: boolean | undefined,
): string {
  const described = basisDescription(basis, end);
  if (!described) return "";
  return filing
    ? `${described}, ${sourceLabel(FILING_SOURCE).toLowerCase()}`
    : described;
}

const DT = "text-muted-foreground";
const DD = "text-right tabular-nums text-foreground";

/**
 * The native disclosure in the Stock cell. It needs no state and no script,
 * so it opens in the ISR HTML before (and without) hydration. The code and
 * name link above it stays the canonical /shorts/<code>; "Full financials"
 * links the stock page's Financials tab and stays nofollow: the stock page's
 * own tab bar and the sitemap already lead a crawler there.
 */
export function PickFundamentalsDetails({ row }: { row: PickRow }) {
  const f = row.fundamentals;
  return (
    <details className="group mt-1 max-w-[18rem] text-xs">
      <summary className="w-fit cursor-pointer select-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
        Fundamentals
      </summary>
      {f ? (
        <div className="mt-2 min-w-[14rem] space-y-2 rounded-md border border-border/60 bg-muted/30 p-2">
          <PickFundamentalsList row={row} f={f} />
          <Link
            href={stockTabHref(row.code, "financials")}
            rel="nofollow"
            prefetch={false}
            className="inline-block font-medium text-primary hover:underline"
          >
            Full financials
          </Link>
        </div>
      ) : (
        <p className="mt-2 text-muted-foreground">
          No fundamentals held for {row.code} yet.
        </p>
      )}
    </details>
  );
}

function PickFundamentalsList({
  row,
  f,
}: {
  row: PickRow;
  f: PickFundamentalsView;
}) {
  const revenue = basisLine(f.revenueBasis, f.revenueEnd, f.revenueFiling);
  const eps = basisLine(f.epsBasis, f.epsEnd, f.epsFiling);
  const ratios = pickRatioLines(f);
  const fetched = formatDate(f.fetchedOn);
  return (
    <dl
      aria-label={`${row.code} fundamentals`}
      className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5"
    >
      {ratios.map((line) => (
        <div key={line.label} className="contents">
          <dt className={DT}>
            <span title={line.title} className="cursor-help">
              {line.label}
            </span>
          </dt>
          <dd
            className={cn(
              DD,
              isMuted(line.value.text) && "text-muted-foreground",
            )}
          >
            <span title={line.value.title}>{line.value.text}</span>
          </dd>
        </div>
      ))}
      {revenue ? (
        <div className="contents">
          <dt className={DT}>Revenue growth</dt>
          <dd className="text-right">{revenue}</dd>
        </div>
      ) : null}
      {eps ? (
        <div className="contents">
          <dt className={DT}>EPS growth</dt>
          <dd className="text-right">{eps}</dd>
        </div>
      ) : null}
      {fetched ? (
        <div className="contents">
          <dt className={DT}>Fetched</dt>
          <dd className="text-right tabular-nums">
            <time dateTime={f.fetchedOn}>{fetched}</time>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/** The value of the added "Sorted by" column for a metric the table has no column for. */
export function sortedByValue(row: PickRow, key: PickSortKey): FormattedValue {
  const f = row.fundamentals;
  switch (key) {
    case "roe":
      return { text: formatPct(f?.roePct) };
    case "net_margin":
      return { text: formatPct(f?.netMarginPct) };
    case "fcf_margin":
      return asFormatted(
        ratioOrNotMeaningful(
          "fcf_margin_pct",
          f?.fcfMarginPct,
          f?.notMeaningful,
          formatPct,
        ),
      );
    case "pe":
      return (f && peValue(f)) ?? { text: NOT_AVAILABLE };
    case "market_cap":
      // The resolved market cap, in AUD: our own close x shares, or the
      // screener's figure where no share count is held (the header says so).
      return { text: formatAmount(row.marketCap, "AUD") };
    default:
      return { text: NOT_AVAILABLE, title: pickSortDef(key).title };
  }
}

/** The "Sorted by" column's cell content. */
export function SortedByValue({
  row,
  sortKey,
}: {
  row: PickRow;
  sortKey: PickSortKey;
}) {
  const value = sortedByValue(row, sortKey);
  return (
    <span
      title={value.title}
      className={isMuted(value.text) ? "text-muted-foreground" : undefined}
    >
      {value.text}
    </span>
  );
}
