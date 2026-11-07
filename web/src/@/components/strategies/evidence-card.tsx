import Link from "next/link";

import { cn } from "@/lib/utils";
import { sectionTitle } from "@/lib/typography";
import type {
  BacktestRunView,
  StrategyEvidenceView,
} from "@/lib/strategies/map-backtest";
import {
  DEFAULT_BACKTEST_WINDOW,
  cagrShown,
  sharpeShown,
} from "@/lib/strategies/backtest-windows";
import { lowestCoverageYear } from "@/lib/strategies/backtest-tables";
import { nextDay } from "@/lib/strategies/backtest-series";
import {
  NOT_COMPUTABLE_BODY,
  inSampleChip,
  notComputableHeadline,
  notComputableNoLabel,
  runRequiredCopy,
  runningCopy,
  shortDate,
} from "@/lib/strategies/backtest-copy";
import { NOT_AVAILABLE, formatPct, formatSigned } from "@/lib/strategies/format";
import { strategyTabHref } from "@/lib/strategies/strategy-tabs";

export interface EvidenceCardProps {
  /** The strategy's slug, for the link to its Backtest tab. */
  slug: string;
  evidence: StrategyEvidenceView;
  /** The run the card's coverage line reads (the published run, when one exists). */
  run: BacktestRunView | null;
}

/**
 * The Overview's Evidence card (design 1.5): the headline of the since-May-2019
 * window (CAGR, max drawdown, Sharpe with its error, closed trades), the
 * in-sample and live split, the lowest coverage year and a link to the full
 * backtest. Every state the explorer names gets its own copy (1.7): a run still
 * to come, a run in progress, and a fundamentals strategy that cannot be tested
 * yet, which names the measured label. Nothing is drawn in red or green.
 */
export function EvidenceCard({ slug, evidence, run }: EvidenceCardProps) {
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
            ? runningCopy(run?.runningSince ?? "")
            : runRequiredCopy(evidence.version?.label ?? "", evidence.version?.rulesHash ?? "", run?.stateReason ?? "")}
        </p>
        <Link href={backtestHref} prefetch={false} className="text-sm text-primary hover:underline">
          Backtest →
        </Link>
      </section>
    );
  }
  const window = evidence.windows.find((w) => w.window === DEFAULT_BACKTEST_WINDOW) ?? null;
  if (!window) return null;
  const lowest = run ? lowestCoverageYear(run.coverageByYear) : null;
  const sharpe = sharpeShown(window);
  // The freeze is the session after the in-sample end (1.8: "rules frozen <live_from>").
  const liveFrom = run?.identity?.inSampleUntil ? nextDay(run.identity.inSampleUntil) : "";
  return (
    <section aria-labelledby="evidence-heading" className="space-y-4 rounded-lg border border-border/60 bg-card p-5" data-evidence-state={evidence.state}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="evidence-heading" className={sectionTitle}>Backtest evidence</h2>
        <span className="font-mono text-[11px] text-muted-foreground">{inSampleChip(liveFrom)}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Figure label={cagrShown(window) ? "CAGR" : "Total return"} value={cagrShown(window) ? formatPct(window.cagrPct) : window.totalReturnPct === null ? NOT_AVAILABLE : formatSigned(window.totalReturnPct, "%")} note={cagrShown(window) ? undefined : "not annualised"} />
        <Figure label="Max drawdown" value={formatSigned(window.maxDrawdownPct, "%")} />
        <Figure
          label="Sharpe"
          value={sharpe && window.sharpe !== null ? `${window.sharpe.toFixed(2)}${window.sharpeSe !== null ? ` (± ${window.sharpeSe.toFixed(2)})` : ""}` : "n/m"}
        />
        <Figure label="Closed trades" value={String(window.closedTrades)} />
      </dl>
      <p className="text-xs text-muted-foreground">
        Since May 2019{window.to ? `, to ${shortDate(window.to)}` : ""}.
        {evidence.paper ? (
          evidence.paper.tooShort ? (
            <> Recorded since {shortDate(evidence.paper.since) || "the freeze"}: too short to judge.</>
          ) : (
            <>
              {" "}Recorded since {shortDate(evidence.paper.since)}
              {evidence.paper.returnPct !== null ? <>: {formatSigned(evidence.paper.returnPct, "%")}</> : null}.
            </>
          )
        ) : null}
        {lowest ? <> Lowest measured coverage: {lowest.year}, {Math.round(lowest.coveragePct ?? 0)}%.</> : null}
      </p>
      <Link href={backtestHref} prefetch={false} className="inline-flex text-sm font-medium text-primary hover:underline">
        Full backtest →
      </Link>
    </section>
  );
}

function NotComputableCard({
  evidence,
  backtestHref,
}: {
  evidence: StrategyEvidenceView;
  backtestHref: string;
}) {
  const label = evidence.fiscalLabel;
  const share = evidence.computableSharePct;
  return (
    <section aria-labelledby="evidence-heading" className="space-y-3 rounded-lg border border-border/60 bg-card p-5">
      <h2 id="evidence-heading" className={sectionTitle}>Backtest</h2>
      <p className={cn("text-sm font-medium")}>
        {label ? notComputableHeadline(label) : notComputableNoLabel(share)}
      </p>
      {label ? <p className="text-sm text-muted-foreground">{NOT_COMPUTABLE_BODY}</p> : null}
      <Link href={backtestHref} prefetch={false} className="text-sm text-primary hover:underline">
        Why this strategy has no backtest →
      </Link>
    </section>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xl tabular-nums">{value}</dd>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}
