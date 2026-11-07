import { cn } from "@/lib/utils";
import { NOT_AVAILABLE, formatCount, formatPct, formatSigned } from "@/lib/strategies/format";
import type {
  BacktestWindowView,
  PaperTrackView,
} from "@/lib/strategies/map-backtest";
import {
  SHARPE_MIN_RETURNS,
  cagrShown,
  sharpeShown,
  windowLabel,
} from "@/lib/strategies/backtest-windows";
import {
  outOfSampleLine,
  referenceSpanCopy,
  referenceUnmeasuredCopy,
  shortDate,
  tooShortCopy,
} from "@/lib/strategies/backtest-copy";

export interface RunSummaryProps {
  /** The window the page is showing. */
  window: BacktestWindowView | null;
  /** The recorded paper track since the freeze, or null when the run has none. */
  paper: PaperTrackView | null;
  /** The in-sample average hold, in sessions; null when the run does not state it. */
  avgHoldSessions: number | null;
  /** The same-data reference's name, for the reference gap's note. */
  referenceName: string;
}

/**
 * The run summary of the selected window (design 1.5): the headline figures, the Sharpe
 * with its standard error, the trade counts, and the out-of-sample row. A figure the API
 * does not state prints "n/a", never zero. CAGR appears only over a year or more; under a
 * year the window's total return is shown beside XJT's and the reference's (item 17).
 */
export function RunSummary({ window, paper, avgHoldSessions, referenceName }: RunSummaryProps) {
  if (!window) {
    return <p className="text-sm text-muted-foreground">No figures for this window in the run.</p>;
  }
  const annualised = cagrShown(window);
  const sharpe = sharpeShown(window);
  const referenceGap =
    window.cagrPct !== null && window.referenceCagrPct !== null ? window.cagrPct - window.referenceCagrPct : null;
  return (
    <div className="space-y-4" data-window-summary={window.window}>
      <p className="font-mono text-xs text-muted-foreground">
        {windowLabel(window.window)}
        {window.from && window.to ? ` · ${shortDate(window.from)} to ${shortDate(window.to)}` : ""}
        {window.note ? ` · ${window.note}` : ""}
      </p>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-4">
        {annualised ? (
          <Metric label="Net CAGR" value={formatPct(window.cagrPct)} large />
        ) : (
          <Metric
            label="Total return"
            value={window.totalReturnPct === null ? NOT_AVAILABLE : formatSigned(window.totalReturnPct, "%")}
            note="not annualised"
            large
          />
        )}
        {annualised ? (
          <Metric label="Benchmark CAGR" value={window.benchmarkCagrPct === null ? NOT_AVAILABLE : formatPct(window.benchmarkCagrPct)} large />
        ) : (
          <Metric
            label="XJT total return"
            value={window.benchmarkTotalReturnPct === null ? NOT_AVAILABLE : formatSigned(window.benchmarkTotalReturnPct, "%")}
            large
          />
        )}
        <Metric label="Max drawdown" value={formatSigned(window.maxDrawdownPct, "%")} negative={window.maxDrawdownPct < 0} large />
        <Metric
          label="Sharpe"
          value={sharpe && window.sharpe !== null ? `${window.sharpe.toFixed(2)}${window.sharpeSe !== null ? ` (± ${window.sharpeSe.toFixed(2)})` : ""}` : "n/m"}
          note={sharpe ? undefined : `under ${SHARPE_MIN_RETURNS} daily returns`}
          nowrap
        />
        <Metric label="Closed trades" value={formatCount(window.closedTrades)} />
        <Metric label="Win rate" value={window.winRatePct === null ? NOT_AVAILABLE : formatPct(window.winRatePct, 0)} />
        <Metric label="Exposure" value={formatPct(window.exposurePct, 0)} />
        <Metric
          label="Average hold"
          value={avgHoldSessions === null ? NOT_AVAILABLE : `${Math.round(avgHoldSessions)} sessions`}
          note="in-sample trades"
        />
        <Metric
          label={`vs same-data reference ${referenceSpanCopy(window.referenceTo)}`.trim()}
          value={referenceGap === null ? referenceUnmeasuredCopy(window.referenceTo) : formatSigned(referenceGap, " pp")}
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
  nowrap,
}: {
  label: string;
  value: string;
  note?: string;
  negative?: boolean;
  large?: boolean;
  nowrap?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-mono tabular-nums",
          large ? "text-2xl leading-tight" : "text-base",
          nowrap && "whitespace-nowrap",
          negative && "text-[color:var(--semantic-red-text)]",
        )}
      >
        {value}
      </dd>
      {note ? <p className="text-[11px] leading-snug text-muted-foreground">{note}</p> : null}
    </div>
  );
}
