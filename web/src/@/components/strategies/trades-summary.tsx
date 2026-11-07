import type { TradeSummaryView } from "@/lib/strategies/map-backtest";
import { NOT_AVAILABLE, formatCount, formatPct, formatSigned } from "@/lib/strategies/format";

export interface TradesSummaryProps {
  summary: TradeSummaryView;
}

/**
 * The public trade summary (2.2): the count, win rate, average hold, average win and
 * loss, best and worst net return, and the exits by reason. Anonymous visitors get
 * exactly this; the list of trades is signed-in only.
 */
export function TradesSummary({ summary }: TradesSummaryProps) {
  const exits = Object.entries(summary.exitsByReason).sort(([, a], [, b]) => b - a);
  return (
    <div className="space-y-4" data-trade-summary>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Figure label="Closed trades" value={formatCount(summary.closed)} />
        <Figure label="Win rate" value={summary.winRatePct === null ? NOT_AVAILABLE : formatPct(summary.winRatePct, 0)} />
        <Figure label="Average hold" value={summary.avgHoldSessions === null ? NOT_AVAILABLE : `${Math.round(summary.avgHoldSessions)} sessions`} />
        <Figure label="Open at end" value={formatCount(summary.openAtEnd)} />
        <Figure label="Average win" value={summary.avgWinPct === null ? NOT_AVAILABLE : formatSigned(summary.avgWinPct, "%")} />
        <Figure label="Average loss" value={summary.avgLossPct === null ? NOT_AVAILABLE : formatSigned(summary.avgLossPct, "%")} />
        <Figure label="Best trade" value={summary.bestPct === null ? NOT_AVAILABLE : formatSigned(summary.bestPct, "%")} />
        <Figure label="Worst trade" value={summary.worstPct === null ? NOT_AVAILABLE : formatSigned(summary.worstPct, "%")} />
      </dl>
      {exits.length > 0 ? (
        <div>
          <h3 className="mb-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">Exits by reason</h3>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {exits.map(([reason, count]) => (
              <li key={reason} className="flex justify-between gap-3 border-b border-border/40 py-1">
                <span className="text-muted-foreground">{exitReasonLabel(reason)}</span>
                <span className="font-mono tabular-nums">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** The exit reasons of 5.10, in words a reader follows. An unlisted code reads as a plain phrase. */
export function exitReasonLabel(reason: string): string {
  const known: Record<string, string> = {
    pivot_stop: "Closed below the captured pivot",
    time_stop: "Time stop",
    stop_loss: "Stop loss",
    sma_stop: "Closed below the moving average",
    status_exit: "Left the screen",
    delisted_exit: "Delisted",
    suspended_exit: "Suspended",
    corporate_action_exit: "Corporate action",
    open_at_end: "Open at the end of the run",
  };
  const label = known[reason];
  if (label) return label;
  const words = reason.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-lg tabular-nums">{value}</dd>
    </div>
  );
}
