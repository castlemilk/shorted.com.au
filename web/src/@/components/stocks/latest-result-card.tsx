import { FileText } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import {
  NOT_AVAILABLE,
  basisDescription,
  formatAmount,
  formatAsOf,
  formatDate,
  formatGrowthPct,
  formatPerShare,
  periodColumnLabel,
  sourceLabel,
} from "~/@/lib/fundamentals/format";
import type {
  StockFundamentals,
  StockFundamentalsGrowth,
  StockFundamentalsPeriod,
  StockLatestFiling,
} from "~/app/actions/getStockFundamentals";
import {
  daysBetween,
  latestResultPeriod,
  latestResultSourceDocument,
  priorCorrespondingPeriod,
} from "./fundamentals-model";
import { GrowthFigureView, growthFigures } from "./growth-figures";
import { ProvenanceLegend, ProvenanceMark } from "./provenance";
import { DEFAULT_VENDOR_SOURCE } from "./statement-lines";

// Latest result (docs/plans/fundamentals-coverage.md §7.1, item 1). A
// props-only server card: the newest flow period's revenue, NPAT and EPS
// against the prior corresponding period, with source and as-at per figure;
// the growth row as the picker states it; and the filing summary. The filing
// link comes ONLY from the period's source_document_url. The raw extraction
// tiles this replaces are gone.

type FigureKind = "revenue" | "netIncome" | "eps";

interface Figure {
  kind: FigureKind;
  label: string;
  /** Wire field name, the `field_sources` key. */
  wire: string;
  latest: number | null;
  prior: number | null;
  latestSource: string;
  priorSource: string;
}

/** Where one value came from: its field_sources entry, else its row's source. */
function valueSource(period: StockFundamentalsPeriod, wire: string): string {
  return period.fieldSources[wire] ?? period.source;
}

/** A mark only for values that did not come from the default vendor. */
function markedSource(source: string): string {
  return source && source !== DEFAULT_VENDOR_SOURCE ? source : "";
}

function epsField(
  latest: StockFundamentalsPeriod,
): { wire: "eps_diluted" | "eps_basic"; label: string } {
  return latest.epsDiluted !== null
    ? { wire: "eps_diluted", label: "EPS (diluted)" }
    : { wire: "eps_basic", label: "EPS (basic)" };
}

function epsValue(
  period: StockFundamentalsPeriod | null,
  wire: "eps_diluted" | "eps_basic",
): number | null {
  if (!period) return null;
  return wire === "eps_diluted" ? period.epsDiluted : period.epsBasic;
}

function buildFigures(
  latest: StockFundamentalsPeriod,
  prior: StockFundamentalsPeriod | null,
): Figure[] {
  const eps = epsField(latest);
  const source = (period: StockFundamentalsPeriod | null, wire: string) =>
    period ? valueSource(period, wire) : "";
  return [
    {
      kind: "revenue",
      label: "Revenue",
      wire: "revenue",
      latest: latest.revenue,
      prior: prior?.revenue ?? null,
      latestSource: source(latest, "revenue"),
      priorSource: source(prior, "revenue"),
    },
    {
      kind: "netIncome",
      label: "NPAT",
      wire: "net_income",
      latest: latest.netIncome,
      prior: prior?.netIncome ?? null,
      latestSource: source(latest, "net_income"),
      priorSource: source(prior, "net_income"),
    },
    {
      kind: "eps",
      label: eps.label,
      wire: eps.wire,
      latest: epsValue(latest, eps.wire),
      // The same EPS measure on both sides, never diluted against basic.
      prior: epsValue(prior, eps.wire),
      latestSource: source(latest, eps.wire),
      priorSource: source(prior, eps.wire),
    },
  ];
}

function formatFigure(
  figure: Figure,
  value: number | null,
  currency: string,
  mixed: boolean,
): string {
  return figure.kind === "eps"
    ? formatPerShare(value, currency, { mixed })
    : formatAmount(value, currency, { mixed });
}

/**
 * "Prior loss, now profit" on the SAME basis as the EPS growth figure (the
 * evaluator's rule): the basis period's EPS is positive and the same period a
 * year earlier was not. Only said when the growth figure itself is unknown.
 */
export function isEpsTurnaround(
  periods: readonly StockFundamentalsPeriod[],
  growth: StockFundamentalsGrowth | null,
): boolean {
  if (!growth || growth.epsYoyPct !== null) return false;
  const basis = growth.basisPeriodType;
  if (!basis || !growth.latestPeriodEnd) return false;
  const latest = periods.find(
    (p) =>
      p.periodType === basis &&
      Math.abs(daysBetween(p.periodEnd, growth.latestPeriodEnd) ?? 99) <= 10,
  );
  if (!latest) return false;
  const prior = priorCorrespondingPeriod(periods, latest);
  if (!prior) return false;
  const wire = epsField(latest).wire;
  const now = epsValue(latest, wire);
  const before = epsValue(prior, wire);
  return now !== null && before !== null && now > 0 && before <= 0;
}

function HalfLine({ growth }: { growth: StockFundamentalsGrowth }) {
  const revenue = growth.revenueHalfYoyPct;
  const eps = growth.epsHalfYoyPct;
  const bothOnHalf =
    growth.revenueBasisPeriodType === "half" && growth.basisPeriodType === "half";
  if ((revenue === null && eps === null) || bothOnHalf) return null;
  const end = formatDate(growth.halfLatestPeriodEnd);
  const revenueText = formatGrowthPct(revenue);
  const epsText = formatGrowthPct(eps);
  return (
    <p className="font-mono text-xs tabular-nums text-muted-foreground">
      <span className="text-foreground">HY{end ? ` to ${end}` : ""}:</span> Rev{" "}
      <span className="text-foreground" title={revenueText.title}>
        {revenueText.text}
      </span>{" "}
      · EPS{" "}
      <span className="text-foreground" title={epsText.title}>
        {epsText.text}
      </span>{" "}
      vs the same half a year earlier
    </p>
  );
}

function FilingSummary({ filing }: { filing: StockLatestFiling }) {
  const date = formatDate(filing.reportDate);
  return (
    <div className="space-y-1.5 border-t pt-3">
      <p className="text-xs text-muted-foreground">
        Summary of {filing.reportTitle}
        {date ? `, ${date}` : ""}
      </p>
      <p className="text-sm leading-relaxed text-foreground">{filing.digest}</p>
      <p className="text-[11px] text-muted-foreground">
        Automated summary of the filing; the filing itself is the record.
      </p>
    </div>
  );
}

export interface LatestResultCardProps {
  fundamentals: StockFundamentals;
}

export function LatestResultCard({ fundamentals }: LatestResultCardProps) {
  const latest = latestResultPeriod(fundamentals.periods);
  const growth = fundamentals.growth;
  const filing = fundamentals.latestFiling;
  if (!latest && !growth && !filing) return null;

  const prior = latest
    ? priorCorrespondingPeriod(fundamentals.periods, latest)
    : null;
  const figures = latest ? buildFigures(latest, prior) : [];
  const mixed = Boolean(
    latest && prior?.currency && prior.currency !== latest.currency,
  );
  const document = latestResultSourceDocument(fundamentals);
  const documentDate = document ? formatDate(document.date) : "";
  const turnaround = isEpsTurnaround(fundamentals.periods, growth);
  const marks = figures.flatMap((figure) => [
    figure.latest !== null ? markedSource(figure.latestSource) : "",
    figure.prior !== null ? markedSource(figure.priorSource) : "",
  ]);
  const growthMarks = growth
    ? growthFigures(growth)
        .filter((figure) => figure.fromFiling)
        .map(() => "asx-filing-extraction")
    : [];

  const latestLabel = latest
    ? periodColumnLabel(latest.periodType, latest.periodEnd, latest.fiscalYear)
    : "";
  const priorLabel = prior
    ? periodColumnLabel(prior.periodType, prior.periodEnd, prior.fiscalYear)
    : "";

  return (
    <Card role="region" aria-labelledby="latest-result-heading">
      <CardHeader className="pb-3">
        <CardTitle
          id="latest-result-heading"
          className="flex items-center gap-2 text-lg"
        >
          <FileText className="h-5 w-5" aria-hidden />
          Latest result
        </CardTitle>
        {latest ? (
          <CardDescription className="text-xs">
            {basisDescription(latest.periodType, latest.periodEnd)} ({latestLabel})
            {prior ? ` vs ${priorLabel}` : ""}
            {latest.currency && !mixed
              ? `, figures in ${latest.currency}, the reporting currency`
              : ""}
            {document ? (
              <>
                {" · "}
                <a
                  href={document.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Company filing{documentDate ? `, ${documentDate}` : ""}
                </a>
              </>
            ) : null}
          </CardDescription>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4">
        {latest ? (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {figures.map((figure) => {
              const latestText = formatFigure(
                figure,
                figure.latest,
                latest.currency,
                mixed,
              );
              const priorText = prior
                ? formatFigure(figure, figure.prior, prior.currency, mixed)
                : NOT_AVAILABLE;
              const asAt = formatAsOf(latest.fetchedAt);
              const latestMark =
                figure.latest !== null ? markedSource(figure.latestSource) : "";
              const priorMark =
                figure.prior !== null ? markedSource(figure.priorSource) : "";
              return (
                <div key={figure.kind} className="min-w-0">
                  <dt className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    {figure.label}
                  </dt>
                  <dd className="mt-1 font-mono tabular-nums">
                    <span
                      className={
                        latestText === NOT_AVAILABLE
                          ? "text-lg text-muted-foreground"
                          : "text-lg text-foreground"
                      }
                    >
                      {latestText}
                    </span>
                    {latestMark ? <ProvenanceMark source={latestMark} /> : null}
                    <span className="ml-2 text-xs text-muted-foreground">
                      vs {priorText}
                      {priorMark ? <ProvenanceMark source={priorMark} /> : null}
                      {prior ? ` (${priorLabel})` : ""}
                    </span>
                  </dd>
                  {figure.latest !== null ? (
                    <dd className="mt-0.5 text-[11px] text-muted-foreground">
                      {sourceLabel(figure.latestSource) || "Source not stated"}
                      {asAt ? `, as at ${asAt}` : ""}
                    </dd>
                  ) : null}
                </div>
              );
            })}
          </dl>
        ) : null}

        {growth ? (
          <div className="space-y-2">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {growthFigures(growth).map((figure) => (
                <GrowthFigureView key={figure.label} figure={figure} />
              ))}
            </dl>
            {turnaround ? (
              <p className="text-xs text-muted-foreground">
                EPS: prior loss, now profit (growth is not meaningful against a
                loss).
              </p>
            ) : null}
            <HalfLine growth={growth} />
          </div>
        ) : null}

        <ProvenanceLegend sources={[...marks, ...growthMarks]} />

        {filing ? <FilingSummary filing={filing} /> : null}
      </CardContent>
    </Card>
  );
}
