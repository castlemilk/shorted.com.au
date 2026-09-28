import {
  basisDescription,
  basisLabel,
  formatAsOf,
  formatGrowthPct,
  formatPct,
  formatProseAmount,
  isGrowthMeaningful,
  isNotMeaningful,
  sourceListLabel,
} from "~/@/lib/fundamentals/format";
import type { StockFundamentals } from "~/app/actions/getStockFundamentals";
import {
  latestResultPeriod,
  priorCorrespondingPeriod,
  valueSource,
} from "./fundamentals-model";

// The crawlable one-paragraph fundamentals summary on the Overview
// (docs/plans/fundamentals-coverage.md §7.1). Server-rendered prose built only
// from figures the API holds: every clause is omitted, never guessed, when its
// figure is missing, and the whole paragraph is omitted without a held result.
// Prose marks every amount with its currency ("US$58.8B", "A$3.1B"), so a
// non-AUD reporter can never be read as AUD. The closing "source:" clause
// names the source of every figure the paragraph quotes (its field_sources
// entry, else its row's source), so a filing- or Markit-filled revenue or
// NPAT on a vendor row is never credited to the vendor.

/** The source id a filing-based growth basis is credited to. */
const FILING_SOURCE = "asx-filing-extraction";

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function profitClause(netIncome: number, currency: string): string {
  return netIncome < 0
    ? `a net loss after tax of ${formatProseAmount(-netIncome, currency)}`
    : `net profit after tax of ${formatProseAmount(netIncome, currency)}`;
}

/** The summary's sentences, or null when there is nothing to say. */
export function fundamentalsSummarySentences(
  companyName: string,
  code: string,
  fundamentals: StockFundamentals | null,
): string[] | null {
  if (!fundamentals) return null;
  const latest = latestResultPeriod(fundamentals.periods);
  if (!latest || (latest.revenue === null && latest.netIncome === null)) {
    return null;
  }
  const currency = latest.currency;
  const period = lowerFirst(basisDescription(latest.periodType, latest.periodEnd));
  // The source of every figure quoted below, in the order it is quoted.
  const sources: string[] = [];
  const figures: string[] = [];
  if (latest.revenue !== null) {
    figures.push(`revenue of ${formatProseAmount(latest.revenue, currency)}`);
    sources.push(valueSource(latest, "revenue"));
  }
  if (latest.netIncome !== null) {
    figures.push(profitClause(latest.netIncome, currency));
    sources.push(valueSource(latest, "net_income"));
  }

  const sentences: string[] = [];
  const name = companyName || code;
  sentences.push(
    `${period ? `In the ${period}, ` : ""}${name} (ASX:${code}) recorded ${figures.join(" and ")}.`,
  );

  const prior = priorCorrespondingPeriod(fundamentals.periods, latest);
  if (prior && prior.currency === currency) {
    const priorFigures: string[] = [];
    if (latest.revenue !== null && prior.revenue !== null) {
      priorFigures.push(`revenue of ${formatProseAmount(prior.revenue, currency)}`);
      sources.push(valueSource(prior, "revenue"));
    }
    if (latest.netIncome !== null && prior.netIncome !== null) {
      priorFigures.push(profitClause(prior.netIncome, currency));
      sources.push(valueSource(prior, "net_income"));
    }
    if (priorFigures.length > 0) {
      sentences.push(`A year earlier it recorded ${priorFigures.join(" and ")}.`);
    }
  }

  const growth = fundamentals.growth;
  if (growth) {
    const clauses: string[] = [];
    const revenueBasis = basisLabel(growth.revenueBasisPeriodType || "annual");
    if (isGrowthMeaningful(growth.revenueYoyPct)) {
      clauses.push(
        `revenue ${formatGrowthPct(growth.revenueYoyPct).text}${
          revenueBasis ? ` (${revenueBasis})` : ""
        }`,
      );
      // A vendor basis names no vendor, so only a filing basis adds a source.
      if (growth.revenueBasisSource === "filing") sources.push(FILING_SOURCE);
    }
    const epsBasis = basisLabel(growth.basisPeriodType);
    if (isGrowthMeaningful(growth.epsYoyPct)) {
      clauses.push(
        `EPS ${formatGrowthPct(growth.epsYoyPct).text}${epsBasis ? ` (${epsBasis})` : ""}`,
      );
      if (growth.epsBasisSource === "filing") sources.push(FILING_SOURCE);
    }
    if (clauses.length > 0) {
      sentences.push(`Year-on-year growth: ${clauses.join(", ")}.`);
    }
  }

  const quality = fundamentals.quality;
  if (quality) {
    const ratios: string[] = [];
    const netMarginQuoted =
      quality.netMarginPct !== null &&
      !isNotMeaningful("net_margin_pct", quality.notMeaningful);
    if (netMarginQuoted) {
      ratios.push(`net margin ${formatPct(quality.netMarginPct)}`);
    }
    if (quality.roePct !== null && !isNotMeaningful("roe_pct", quality.notMeaningful)) {
      ratios.push(`return on equity ${formatPct(quality.roePct)}`);
    }
    if (ratios.length > 0) {
      // Both ratios read the basis period's NPAT; net margin also its revenue.
      const basis = fundamentals.periods.find(
        (p) =>
          p.periodType === quality.basisPeriodType &&
          p.periodEnd === quality.basisPeriodEnd,
      );
      if (basis) {
        if (netMarginQuoted) sources.push(valueSource(basis, "revenue"));
        sources.push(valueSource(basis, "net_income"));
      } else {
        sources.push(quality.source);
      }
      const tag = basisLabel(quality.basisPeriodType);
      sentences.push(
        `${ratios.join(", ").replace(/^./, (c) => c.toUpperCase())}${
          tag ? ` (${tag})` : ""
        }.`,
      );
    }
  }

  const asAt = formatAsOf(latest.fetchedAt);
  const source = sourceListLabel(sources);
  sentences.push(
    `Figures are in ${currency || "the company's reporting currency"}${
      currency ? ", the company's reporting currency" : ""
    }${source ? `; source: ${source}` : ""}${asAt ? `, as at ${asAt}` : ""}.`,
  );
  return sentences;
}

export interface FundamentalsSummaryProps {
  stockCode: string;
  companyName: string;
  fundamentals: StockFundamentals | null;
}

export function FundamentalsSummary({
  stockCode,
  companyName,
  fundamentals,
}: FundamentalsSummaryProps) {
  const sentences = fundamentalsSummarySentences(companyName, stockCode, fundamentals);
  if (!sentences) return null;
  return (
    <section
      aria-labelledby="fundamentals-summary-heading"
      className="rounded-lg border bg-card px-4 py-3"
    >
      <h2 id="fundamentals-summary-heading" className="text-sm font-medium">
        {stockCode} fundamentals
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {sentences.join(" ")}
      </p>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Full statements, ratios and filings are on the Financials tab. Not
        financial advice.
      </p>
    </section>
  );
}
