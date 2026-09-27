import { Table2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { NOT_AVAILABLE, formatSigned } from "~/@/lib/strategies/format";
import type {
  StockFundamentals,
  StockFundamentalsPeriod,
} from "~/app/actions/getStockFundamentals";

// Reported annual fundamentals on /shorts/[stockCode] (plan §8). Props-only
// server component: no fetching, no client state, no protobuf. The page
// passes the result of getStockFundamentals.
//
// Figures are in the company's REPORTING currency (BHP reports in USD), so
// they are never shown with a "$" that would read as AUD: the currency code
// is stated once, in the description, and the cells carry bare compact
// numbers. Missing figures read "n/a", never 0.

interface FundamentalsBlockProps {
  /** Null (API unavailable) and an empty period list both render nothing. */
  fundamentals: StockFundamentals | null;
}

const MINUS = "−";

function sign(value: number): string {
  return value < 0 ? MINUS : "";
}

/** Compact magnitude without a currency symbol: "55.66B", "−412.3M". */
export function formatCompactAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NOT_AVAILABLE;
  const abs = Math.abs(value);
  const s = sign(value);
  if (abs >= 1e12) return `${s}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${s}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${s}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${s}${(abs / 1e3).toFixed(1)}K`;
  return `${s}${abs.toFixed(0)}`;
}

/** Per-share amount: "1.22", "−0.045". Sub-10-cent EPS keeps a third digit. */
export function formatPerShare(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NOT_AVAILABLE;
  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 0.1 ? 3 : 2;
  const rounded = abs.toFixed(digits);
  return Number(rounded) === 0 ? rounded : `${sign(value)}${rounded}`;
}

function parseIsoDate(iso: string): Date | null {
  if (!iso) return null;
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Fixed three-letter months: Intl's en-AU short month varies by ICU build
// ("Jun" vs "June", "Sep" vs "Sept"), and a column header should not.
const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "FY25" when the provider labels the year, else "Jun 2025". */
function periodLabel(period: StockFundamentalsPeriod): string {
  if (period.fiscalYear) return `FY${String(period.fiscalYear).slice(-2)}`;
  const end = parseIsoDate(period.periodEnd);
  if (!end) return period.periodEnd || NOT_AVAILABLE;
  return `${SHORT_MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
}

function periodTitle(period: StockFundamentalsPeriod): string | undefined {
  const end = parseIsoDate(period.periodEnd);
  if (!end) return undefined;
  return `Year ended ${end.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })}`;
}

/**
 * "Prior loss, now profit": the latest annual NPAT is positive and the annual
 * immediately before it was a loss (or break-even). EPS growth is undefined
 * against a prior <= 0, so this is what stands in for it. Both years must be
 * reported and roughly a year apart; anything less is not a claim we make.
 */
export function isTurnaround(periods: StockFundamentalsPeriod[]): boolean {
  const [latest, prior] = periods;
  if (!latest || !prior) return false;
  if (latest.netIncome === null || prior.netIncome === null) return false;
  const latestEnd = parseIsoDate(latest.periodEnd);
  const priorEnd = parseIsoDate(prior.periodEnd);
  if (!latestEnd || !priorEnd) return false;
  const days = (latestEnd.getTime() - priorEnd.getTime()) / 86_400_000;
  if (days < 300 || days > 430) return false;
  return latest.netIncome > 0 && prior.netIncome <= 0;
}

/**
 * Names the series a growth figure compares, a year apart: "TTM" (trailing
 * twelve months), "annual", or "half-year" (the latest half from a company
 * filing vs the same half a year earlier, used when it is fresher).
 */
export function basisLabel(basis: string): string {
  if (basis === "ttm") return "TTM";
  if (basis === "annual") return "annual";
  if (basis === "half") return "half-year";
  return basis;
}

/** "Dec 2025" for a YYYY-MM-DD, or "" when it does not parse. */
function monthYear(iso: string): string {
  const d = parseIsoDate(iso);
  return d ? `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "";
}

interface Row {
  label: string;
  title: string;
  value: (period: StockFundamentalsPeriod) => string;
}

const ROWS: Row[] = [
  {
    label: "Revenue",
    title: "Total revenue for the year",
    value: (p) => formatCompactAmount(p.revenue),
  },
  {
    label: "NPAT",
    title: "Net profit after tax attributable to shareholders",
    value: (p) => formatCompactAmount(p.netIncome),
  },
  {
    label: "Diluted EPS",
    title: "Diluted earnings per share",
    value: (p) => formatPerShare(p.epsDiluted),
  },
  {
    label: "Operating cash flow",
    title: "Net cash from operating activities",
    value: (p) => formatCompactAmount(p.operatingCashFlow),
  },
];

export function FundamentalsBlock({ fundamentals }: FundamentalsBlockProps) {
  const periods = fundamentals?.periods ?? [];
  if (!fundamentals || periods.length === 0) return null;

  const currencies = Array.from(
    new Set(periods.map((p) => p.currency).filter(Boolean)),
  );
  // One currency across every period is the norm; a company that switched
  // reporting currency gets the code under each column instead, so a figure
  // is never read in the wrong unit.
  const uniformCurrency = currencies.length === 1 ? currencies[0]! : null;
  const mixedCurrency = currencies.length > 1;
  const currencyNote = uniformCurrency
    ? `figures in ${uniformCurrency}`
    : mixedCurrency
      ? "reporting currency varies by year"
      : "reporting currency not stated";

  const growth = fundamentals.growth;
  const turnaround = isTurnaround(periods);
  const epsBasis = growth ? basisLabel(growth.basisPeriodType) : "";
  // An API that predates revenue_basis_period_type only ever computed revenue
  // annual on annual, so an empty basis still reads "annual".
  const revenueBasisType = growth?.revenueBasisPeriodType ?? "";
  const revenueBasis = basisLabel(
    revenueBasisType === "" ? "annual" : revenueBasisType,
  );
  // The half-on-half line adds information only when at least one headline
  // figure is NOT already on the half basis.
  const revenueHalf = growth?.revenueHalfYoyPct ?? null;
  const epsHalf = growth?.epsHalfYoyPct ?? null;
  const bothOnHalf =
    growth?.revenueBasisPeriodType === "half" &&
    growth?.basisPeriodType === "half";
  const showHalfLine =
    (revenueHalf !== null || epsHalf !== null) && !bothOnHalf;
  const halfEnd = monthYear(growth?.halfLatestPeriodEnd ?? "");
  const usesHalf =
    showHalfLine ||
    growth?.revenueBasisPeriodType === "half" ||
    growth?.basisPeriodType === "half";
  const yearsLabel =
    periods.length === 1
      ? "Latest financial year"
      : `Last ${periods.length} financial years`;

  return (
    <Card role="region" aria-labelledby="fundamentals-heading">
      <CardHeader className="pb-3">
        <CardTitle
          id="fundamentals-heading"
          className="flex items-center gap-2 text-lg"
        >
          <Table2 className="h-5 w-5" aria-hidden />
          Reported fundamentals
        </CardTitle>
        <CardDescription className="text-xs">
          {yearsLabel}, {currencyNote}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[22rem] border-collapse font-mono text-sm tabular-nums">
            <caption className="sr-only">
              {fundamentals.stockCode} reported annual fundamentals, newest year
              first, {currencyNote}
            </caption>
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="px-1 py-1.5 text-left font-normal">
                  <span className="sr-only">Line item</span>
                </th>
                {periods.map((p) => (
                  <th
                    key={p.periodEnd}
                    scope="col"
                    title={periodTitle(p)}
                    className="px-1 py-1.5 text-right font-normal"
                  >
                    {periodLabel(p)}
                    {mixedCurrency && p.currency ? (
                      <span className="block text-[10px]">{p.currency}</span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {ROWS.map((row) => (
                <tr key={row.label}>
                  <th
                    scope="row"
                    title={row.title}
                    className="whitespace-nowrap px-1 py-1.5 text-left text-xs font-normal text-muted-foreground"
                  >
                    {row.label}
                  </th>
                  {periods.map((p) => {
                    const text = row.value(p);
                    return (
                      <td
                        key={p.periodEnd}
                        className={
                          text === NOT_AVAILABLE
                            ? "px-1 py-1.5 text-right text-muted-foreground"
                            : "px-1 py-1.5 text-right"
                        }
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          <span className="text-foreground">Growth:</span> revenue{" "}
          <span className="text-foreground">
            {formatSigned(growth?.revenueYoyPct ?? null)}
          </span>{" "}
          YoY ({revenueBasis}) · EPS{" "}
          <span className="text-foreground">
            {formatSigned(growth?.epsYoyPct ?? null)}
          </span>{" "}
          YoY{epsBasis ? ` (${epsBasis})` : ""}
          {turnaround ? (
            <>
              {" "}
              · <span className="text-foreground">prior loss, now profit</span>
            </>
          ) : null}
        </p>

        {showHalfLine ? (
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            <span className="text-foreground">
              Half-year{halfEnd ? ` to ${halfEnd}` : ""}:
            </span>{" "}
            revenue{" "}
            <span className="text-foreground">{formatSigned(revenueHalf)}</span>{" "}
            · EPS{" "}
            <span className="text-foreground">{formatSigned(epsHalf)}</span> vs
            the same half a year earlier
          </p>
        ) : null}

        <p className="text-[11px] text-muted-foreground">
          Company-filed figures via market data provider
          {usesHalf ? " and ASX half-year filings" : ""}; reporting currency;
          not financial advice.
        </p>
      </CardContent>
    </Card>
  );
}
