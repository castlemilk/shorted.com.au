import { cn } from "@/lib/utils";
import { NOT_AVAILABLE, formatCount, formatPct, formatSigned } from "@/lib/strategies/format";
import type {
  BacktestWindowView,
  PaperTrackView,
  TradeSummaryView,
} from "@/lib/strategies/map-backtest";
import {
  SHARPE_MIN_RETURNS,
  cagrShown,
  sharpeShown,
  windowLabel,
} from "@/lib/strategies/backtest-windows";
import { outOfSampleLine, tooShortCopy } from "@/lib/strategies/backtest-copy";

export interface RunSummaryProps {
  /** The window the page is showing. */
  window: BacktestWindowView | null;
  /** The recorded paper track since the freeze, or null when the run has none. */
  paper: PaperTrackView | null;
  /** The in-sample closed-trade statistics of the run (average hold). */
  tradeSummary: TradeSummaryView | null;
  /** The reference's name, when the run carries a reference line. */
  referenceName: string;
}

/**
 * The run summary of the selected window (design 1.5): the headline figures, the
 * Sharpe with its standard error, the trade counts, and the out-of-sample row that
 * appears once the paper track can be judged. A figure the API does not state
 * prints "n/a", never zero; CAGR appears only over a year or more, and Sharpe only
 * over 126 returns (5.8).
 */
export function RunSummary({
  window,
  paper,
  tradeSummary,
  referenceName,
}: RunSummaryProps) {
  if (!window) {
    return (
      <p className="text-sm text-muted-foreground">
        No figures for this window in the run.
      </p>
    );
  }
  const annualised = cagrShown(window);
  const sharpe = sharpeShown(window);
  const referenceGap =
    window.cagrPct !== null && window.referenceCagrPct !== null
      ? window.cagrPct - window.referenceCagrPct
      : null;
  return (
    <div className="space-y-4" data-window-summary={window.window}>
      <p className="font-mono text-xs text-muted-foreground">
        {windowLabel(window.window)}
        {window.from && window.to ? ` · ${window.from} to ${window.to}` : ""}
        {window.note ? ` · ${window.note}` : ""}
      </p>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-4">
        <Metric
          label={annualised ? "Net CAGR" : "Total return"}
          value={
            annualised
              ? formatPct(window.cagrPct)
              : window.totalReturnPct === null
                ? NOT_AVAILABLE
                : formatSigned(window.totalReturnPct, "%")
          }
          note={annualised ? undefined : "not annualised"}
          large
        />
        <Metric
          label="Benchmark CAGR"
          value={window.benchmarkCagrPct === null ? NOT_AVAILABLE : formatPct(window.benchmarkCagrPct)}
          large
        />
        <Metric label="Max drawdown" value={formatSigned(window.maxDrawdownPct, "%")} negative={window.maxDrawdownPct < 0} large />
        <Metric
          label="Sharpe"
          value={
            sharpe && window.sharpe !== null
              ? `${window.sharpe.toFixed(2)}${window.sharpeSe !== null ? ` (± ${window.sharpeSe.toFixed(2)})` : ""}`
              : "n/m"
          }
          note={sharpe ? undefined : `under ${SHARPE_MIN_RETURNS} daily returns`}
        />
        <Metric label="Closed trades" value={formatCount(window.closedTrades)} />
        <Metric label="Win rate" value={window.winRatePct === null ? NOT_AVAILABLE : formatPct(window.winRatePct, 0)} />
        <Metric label="Exposure" value={formatPct(window.exposurePct, 0)} />
        <Metric
          label="Average hold"
          value={
            tradeSummary?.avgHoldSessions != null
              ? `${Math.round(tradeSummary.avgHoldSessions)} sessions`
              : NOT_AVAILABLE
          }
          note="in-sample trades"
        />
        <Metric
          label="vs same-data reference"
          value={referenceGap === null ? NOT_AVAILABLE : formatSigned(referenceGap, " pp")}
          note={referenceGap === null ? undefined : referenceName}
        />
      </dl>
      <div className="border-t border-border/60 pt-3 text-sm">
        {paper ? (
          paper.tooShort ? (
            <p className="text-muted-foreground" data-oos="too-short">
              <span className="font-medium text-foreground">{outOfSampleLine(paper)}</span>
              <br />
              {tooShortCopy(paper)}
            </p>
          ) : (
            <p data-oos="recorded">
              <span className="font-medium">{outOfSampleLine(paper)}</span>
              {paper.returnPct !== null ? (
                <span className={cn("ml-2 font-mono tabular-nums", paper.returnPct < 0 && "text-[color:var(--semantic-red-text)]")}>
                  {formatSigned(paper.returnPct, "%")}
                </span>
              ) : null}
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  negative,
  large,
}: {
  label: string;
  value: string;
  note?: string;
  negative?: boolean;
  large?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-mono tabular-nums",
          large ? "text-2xl leading-tight" : "text-base",
          negative && "text-[color:var(--semantic-red-text)]",
        )}
      >
        {value}
      </dd>
      {note ? <p className="text-[11px] leading-snug text-muted-foreground">{note}</p> : null}
    </div>
  );
}
