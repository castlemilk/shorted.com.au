import Link from "next/link";

import { sectionTitle } from "@/lib/typography";
import type {
  AnnualReturnView,
  StrategyEvidenceView,
} from "@/lib/strategies/map-backtest";
import { DEFAULT_BACKTEST_WINDOW, cagrShown, sharpeShown } from "@/lib/strategies/backtest-windows";
import {
  APPROXIMATE_CHIP,
  NOT_COMPUTABLE_BODY,
  inSampleChip,
  notComputableHeadline,
  notComputableNoLabel,
  runRequiredCopy,
  runningCopy,
  shortDate,
  tooShortCopy,
} from "@/lib/strategies/backtest-copy";
import { NOT_AVAILABLE, formatPct, formatSigned } from "@/lib/strategies/format";
import { strategyTabHref } from "@/lib/strategies/strategy-tabs";
import { coverageMeasureName, type CoverageMeasureKey } from "@/lib/strategies/backtest-tables";

export interface EvidenceCardProps {
  /** The strategy's slug, for the link to its Backtest tab. */
  slug: string;
  /** The evidence read alone: every figure the card prints comes from it (item 12). */
  evidence: StrategyEvidenceView;
}

/**
 * The Overview's Evidence card (design 1.5): the since-May-2019 headline, the freeze and the
 * recorded track, the run's lowest measured coverage year named by its measure, and a link to
 * the full backtest. Each non-published state gets its own copy (1.7). It reads the evidence
 * answer alone, so a failed run read cannot degrade it.
 */
export function EvidenceCard({ slug, evidence }: EvidenceCardProps) {
  const backtestHref = strategyTabHref(slug, "backtest");
  if (evidence.state === "not_computable") {
    return <NotComputableCard evidence={evidence} backtestHref={backtestHref} />;
  }
  if (evidence.state === "run_required" || evidence.state === "running") {
    return (
      <section aria-labelledby="evidence-heading" className="space-y-3 rounded-lg border border-border/60 bg-card p-5">
        <h2 id="evidence-heading" className={sectionTitle}>Backtest</h2>
        <p className="text-sm text-muted-foreground">
          {evidence.state === "running"
            ? runningCopy(evidence.runningSince)
            : runRequiredCopy(evidence.version?.label ?? "", evidence.version?.rulesHash ?? "", evidence.stateReason)}
        </p>
        <Link href={backtestHref} prefetch={false} className="text-sm text-primary hover:underline">
          Backtest →
        </Link>
      </section>
    );
  }
  const window = evidence.windows.find((w) => w.window === DEFAULT_BACKTEST_WINDOW) ?? null;
  if (!window) return null;
  const freeze = evidence.version?.liveFrom ?? "";
  const measure = measureFromAnnual(evidence.annual);
  const lowest = lowestOf(evidence.annual, measure);
  return (
    <section aria-labelledby="evidence-heading" className="space-y-4 rounded-lg border border-border/60 bg-card p-5" data-evidence-state={evidence.state}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="evidence-heading" className={sectionTitle}>Backtest evidence</h2>
        <span className="font-mono text-[11px] text-muted-foreground">
          {freeze ? inSampleChip(freeze) : "In-sample backtest"}
        </span>
      </div>
      {evidence.state === "approximate" ? (
        <p className="font-mono text-[11px] text-muted-foreground" data-approximate>{APPROXIMATE_CHIP}</p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {cagrShown(window) ? (
          <Figure label="CAGR" value={formatPct(window.cagrPct)} />
        ) : (
          <Figure label="Total return" value={window.totalReturnPct === null ? NOT_AVAILABLE : formatSigned(window.totalReturnPct, "%")} note="not annualised" />
        )}
        <Figure label="Max drawdown" value={formatSigned(window.maxDrawdownPct, "%")} />
        <Figure
          label="Sharpe"
          value={sharpeShown(window) && window.sharpe !== null ? `${window.sharpe.toFixed(2)}${window.sharpeSe !== null ? ` (± ${window.sharpeSe.toFixed(2)})` : ""}` : "n/m"}
          nowrap
        />
        <Figure label="Closed trades" value={String(window.closedTrades)} />
      </dl>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          Since May 2019{window.to ? `, to ${shortDate(window.to)}` : ""}.
          {evidence.paper ? (
            <>
              {" "}
              {evidence.paper.tooShort
                ? tooShortCopy(evidence.paper)
                : `Recorded since ${shortDate(evidence.paper.recordedFrom || evidence.paper.since)}${
                    evidence.paper.returnPct !== null ? `: ${formatSigned(evidence.paper.returnPct, "%")}` : ""
                  }.`}
            </>
          ) : null}
        </p>
        {lowest ? (
          <p data-lowest-coverage>
            Lowest measured coverage: {lowest.year}, {Math.round(lowest.coveragePct)}% ({coverageMeasureName(measure)}), flatters results.
          </p>
        ) : null}
      </div>
      <Link href={backtestHref} prefetch={false} className="inline-flex text-sm font-medium text-primary hover:underline">
        Full backtest →
      </Link>
    </section>
  );
}

/** The run's one coverage measure, from the latest annual row that names one (the contract's coverage_measure). */
export function measureFromAnnual(annual: readonly AnnualReturnView[]): CoverageMeasureKey {
  const named = [...annual].reverse().find((row) => row.coverageMeasure === "qualifying_5pct_short" || row.coverageMeasure === "all_reported");
  if (!named) return "";
  return named.coverageMeasure === "qualifying_5pct_short" ? "qualifying" : "all_reported";
}

/** The lowest year whose figure the run's measure reports, in percent. */
export function lowestOf(
  annual: readonly AnnualReturnView[],
  measure: CoverageMeasureKey,
): { year: number; coveragePct: number } | null {
  let lowest: { year: number; coveragePct: number } | null = null;
  // Under the all-reported measure only the years from the first the qualifying measure can see
  // count (the same rule as the Backtest tab): a partial run never cites a pre-2025 year.
  const qualifying = annual.filter((row) => row.coverageMeasure === "qualifying_5pct_short").map((row) => row.year);
  const firstQualifying = qualifying.length > 0 ? Math.min(...qualifying) : null;
  for (const row of annual) {
    if (row.coveragePct === null) continue;
    if (measure === "all_reported" && (firstQualifying === null || row.year < firstQualifying)) continue;
    const rowMeasure = row.coverageMeasure === "qualifying_5pct_short" ? "qualifying" : row.coverageMeasure === "all_reported" ? "all_reported" : "";
    if (!rowMeasure || (measure && rowMeasure !== measure)) continue;
    if (lowest === null || lowest.coveragePct > row.coveragePct) lowest = { year: row.year, coveragePct: row.coveragePct };
  }
  return lowest && lowest.coveragePct < 80 ? lowest : null;
}

function NotComputableCard({
  evidence,
  backtestHref,
}: {
  evidence: StrategyEvidenceView;
  backtestHref: string;
}) {
  const label = evidence.fiscalLabel;
  return (
    <section aria-labelledby="evidence-heading" className="space-y-3 rounded-lg border border-border/60 bg-card p-5">
      <h2 id="evidence-heading" className={sectionTitle}>Backtest</h2>
      <p className="text-sm font-medium">{label ? notComputableHeadline(label) : notComputableNoLabel(evidence.computableSharePct)}</p>
      {label ? <p className="text-sm text-muted-foreground">{NOT_COMPUTABLE_BODY}</p> : null}
      <Link href={backtestHref} prefetch={false} className="text-sm text-primary hover:underline">
        Why this strategy has no backtest →
      </Link>
    </section>
  );
}

function Figure({ label, value, note, nowrap }: { label: string; value: string; note?: string; nowrap?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`font-mono text-xl tabular-nums${nowrap ? " whitespace-nowrap" : ""}`}>{value}</dd>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}
