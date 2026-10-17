import { Gauge } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import {
  NOT_AVAILABLE,
  NOT_MEANINGFUL,
  NOT_MEANINGFUL_TITLE,
  basisDescription,
  basisLabel,
  formatAmount,
  formatAsOf,
  formatDate,
  formatInterestCover,
  formatMultiple,
  formatNetDebt,
  formatPct,
  formatRatio,
  isNotMeaningful,
  distinctSourceLabels,
  ratioOrNotMeaningful,
  sourceListLabel,
  valuationNotAvailable,
  type FormattedValue,
} from "~/@/lib/fundamentals/format";
import type {
  StockFundamentalsPeriod,
  StockFundamentalsQuality,
} from "~/app/actions/getStockFundamentals";
import { ratioSources } from "./fundamentals-model";

// Key ratios (docs/plans/fundamentals-coverage.md §7.1, item 2). A props-only
// server card over the API's FundamentalsQuality row: margins, returns, cash
// conversion, leverage, liquidity, payout and valuation, with the basis, the
// balance-sheet lag and the as-at date. n/a = not held; n/m = withheld for a
// bank, insurer or other financial (the API's not_meaningful list); P/E and
// P/B read "n/a (reports in USD)" for a non-AUD reporter. This card replaces
// the stale "Key metrics" card.

/**
 * The valuation notes that explain a missing P/E. "no-shares" does not: P/E
 * is close / EPS and needs no share count, so a null P/E under that note has
 * another cause (a loss, stale EPS) and reads plain "n/a". Market cap and P/B
 * do need the share count and keep it.
 */
const PE_NOTES: readonly string[] = ["non-aud", "listed-unit", "no-price"];

/** The note to explain a missing P/E with, "" when the note does not govern P/E. */
function peNote(note: string): string {
  return PE_NOTES.includes(note.trim().toLowerCase()) ? note : "";
}

interface RatioItem {
  /** Wire name, as `not_meaningful` lists it. */
  name: string;
  label: string;
  /** What the ratio is, for the label's tooltip. */
  hint: string;
  value: FormattedValue;
}

function plain(text: string): FormattedValue {
  return { text };
}

/** A ratio, or n/m (with its title) when the API withheld it. */
function ratio(
  name: string,
  value: number | null,
  notMeaningful: readonly string[],
  fmt: (value: number | null | undefined) => string,
): FormattedValue {
  const result = ratioOrNotMeaningful(name, value, notMeaningful, fmt);
  return typeof result === "string" ? plain(result) : result;
}

export function ratioItems(quality: StockFundamentalsQuality): RatioItem[] {
  const nm = quality.notMeaningful;
  const balanceCurrency = quality.balanceCurrency || quality.currency;
  const netDebtNm = isNotMeaningful("net_debt", nm);
  const netDebt = netDebtNm
    ? null
    : formatNetDebt(quality.netDebt, balanceCurrency, { mixed: true });

  const marketCapNote = ["listed-unit", "no-shares", "no-price"].includes(
    quality.valuationNote,
  )
    ? valuationNotAvailable("AUD", quality.valuationNote)
    : NOT_AVAILABLE;

  return [
    {
      name: "gross_margin_pct",
      label: "Gross margin",
      hint: "Gross profit / revenue",
      value: ratio("gross_margin_pct", quality.grossMarginPct, nm, (v) => formatPct(v)),
    },
    {
      name: "operating_margin_pct",
      label: "Operating margin",
      hint: "Operating income / revenue",
      value: ratio("operating_margin_pct", quality.operatingMarginPct, nm, (v) =>
        formatPct(v),
      ),
    },
    {
      name: "net_margin_pct",
      label: "Net margin",
      hint: "Net profit / revenue",
      value: ratio("net_margin_pct", quality.netMarginPct, nm, (v) => formatPct(v)),
    },
    {
      name: "fcf_margin_pct",
      label: "FCF margin",
      hint: "Free cash flow / revenue",
      value: ratio("fcf_margin_pct", quality.fcfMarginPct, nm, (v) => formatPct(v)),
    },
    {
      name: "roe_pct",
      label: "ROE",
      hint: "Net profit / average shareholders' equity",
      value: ratio("roe_pct", quality.roePct, nm, (v) => formatPct(v)),
    },
    {
      name: "roa_pct",
      label: "ROA",
      hint: "Net profit / average total assets",
      value: ratio("roa_pct", quality.roaPct, nm, (v) => formatPct(v)),
    },
    {
      name: "fcf_conversion",
      label: "FCF conversion",
      hint: "Free cash flow / net profit",
      value: ratio("fcf_conversion", quality.fcfConversion, nm, (v) =>
        formatRatio(v, 2),
      ),
    },
    {
      name: "net_debt",
      label: netDebt?.label ?? "Net debt (excl. leases)",
      hint: "Total debt minus lease liabilities minus cash; negative is net cash",
      value: netDebt
        ? plain(netDebt.text)
        : { text: NOT_MEANINGFUL, title: NOT_MEANINGFUL_TITLE },
    },
    {
      name: "net_debt_to_ebitda",
      label: "Net debt / EBITDA",
      hint: "Net debt (excl. leases) / normalised EBITDA where published",
      value: ratio("net_debt_to_ebitda", quality.netDebtToEbitda, nm, formatMultiple),
    },
    {
      name: "current_ratio",
      label: "Current ratio",
      hint: "Current assets / current liabilities",
      value: ratio("current_ratio", quality.currentRatio, nm, (v) => formatRatio(v)),
    },
    {
      name: "interest_cover",
      label: "Interest cover",
      hint: "Operating income / interest expense",
      value: ratio("interest_cover", quality.interestCover, nm, formatInterestCover),
    },
    {
      name: "payout_ratio_pct",
      label: "Cash dividends paid / net profit",
      hint: "Cash dividends paid in the period / net profit",
      value: ratio("payout_ratio_pct", quality.payoutRatioPct, nm, (v) => formatPct(v)),
    },
    {
      name: "market_cap",
      label: "Market cap",
      hint: "Latest close x shares on issue, in AUD",
      value: plain(
        quality.marketCap !== null
          ? formatAmount(quality.marketCap, "AUD", { mixed: true })
          : marketCapNote,
      ),
    },
    {
      name: "pe_ratio",
      label: "P/E",
      hint: "Latest close / 12-month EPS",
      value: plain(
        quality.peRatio !== null
          ? formatMultiple(quality.peRatio)
          : valuationNotAvailable(quality.currency, peNote(quality.valuationNote)),
      ),
    },
    {
      name: "price_to_book",
      label: "P/B",
      hint: "Market cap / shareholders' equity",
      value: plain(
        quality.priceToBook !== null
          ? formatMultiple(quality.priceToBook)
          : valuationNotAvailable(balanceCurrency, quality.valuationNote),
      ),
    },
  ];
}

function isUnheld(text: string): boolean {
  return text === NOT_MEANINGFUL || text.startsWith(NOT_AVAILABLE);
}

export interface KeyRatiosCardProps {
  quality: StockFundamentalsQuality;
  /** The period the flow ratios read, for its as-at date; null when not held. */
  basisPeriod: StockFundamentalsPeriod | null;
}

export function KeyRatiosCard({ quality, basisPeriod }: KeyRatiosCardProps) {
  const items = ratioItems(quality);
  const basis = basisDescription(quality.basisPeriodType, quality.basisPeriodEnd);
  const tag = basisLabel(quality.basisPeriodType);
  const balanceDate = formatDate(quality.balancePeriodEnd);
  const priceDate = formatDate(quality.priceAsOf);
  const asAt = basisPeriod ? formatAsOf(basisPeriod.fetchedAt) : "";
  // Every source behind the ratios, not only the flow row's: a filing- or
  // Markit-filled revenue or NPAT feeds net margin and ROE.
  const sourceIds = ratioSources(quality.source, basisPeriod);
  const sources = sourceListLabel(sourceIds);
  const plural = distinctSourceLabels(sourceIds).length > 1;
  const anyNotMeaningful = items.some((item) => item.value.text === NOT_MEANINGFUL);

  return (
    <Card role="region" aria-labelledby="key-ratios-heading">
      <CardHeader className="pb-3">
        <CardTitle id="key-ratios-heading" className="flex items-center gap-2 text-lg">
          <Gauge className="h-5 w-5" aria-hidden />
          Key ratios
        </CardTitle>
        <CardDescription className="text-xs">
          {basis ? `${basis}${tag ? ` (${tag})` : ""}` : "Latest period"}
          {balanceDate
            ? `; balance sheet at ${balanceDate}${
                quality.balanceLagMonths !== null && quality.balanceLagMonths > 0
                  ? `, ${quality.balanceLagMonths} month${
                      quality.balanceLagMonths === 1 ? "" : "s"
                    } before`
                  : ""
              }`
            : "; no balance sheet aligned with this period"}
          {priceDate ? `; prices to ${priceDate}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {items.map((item) => (
            <div key={item.name} className="min-w-0">
              <dt
                className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground"
                title={item.hint}
              >
                {item.label}
              </dt>
              <dd
                className={
                  isUnheld(item.value.text)
                    ? "mt-1 font-mono text-sm tabular-nums text-muted-foreground"
                    : "mt-1 font-mono text-sm tabular-nums text-foreground"
                }
                title={item.value.title}
              >
                {item.value.text}
              </dd>
            </div>
          ))}
        </dl>

        <div className="space-y-1 text-[11px] text-muted-foreground">
          {anyNotMeaningful ? (
            <p>
              {NOT_MEANINGFUL}: {NOT_MEANINGFUL_TITLE.toLowerCase()}.
            </p>
          ) : null}
          {quality.isProperty ? (
            <p>
              Property trust: profit and EBITDA include property revaluations,
              so margins and returns move with valuations.
            </p>
          ) : null}
          {quality.operatingCashFlowDerived ? (
            <p>Operating cash flow is derived as free cash flow minus capex.</p>
          ) : null}
          <p>
            Ratios use the reporting currency
            {quality.currency ? ` (${quality.currency})` : ""}; market cap is
            in AUD. {plural ? "Sources" : "Source"}: {sources || "not stated"}
            {asAt ? `, as at ${asAt}` : ""}.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
