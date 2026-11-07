import type { BacktestIdentityView } from "@/lib/strategies/map-backtest";
import { runIdentityDetail, runIdentityLine, shortDate } from "@/lib/strategies/backtest-copy";

export interface RunIdentityProps {
  identity: BacktestIdentityView;
  /** The run's diff note against the previous run (5.14); "" when none. */
  inputChangeNote: string;
}

/**
 * The run's identity: one line that opens a disclosure of the hashes, the
 * recipe, the engine and the dates (1.8 item 1, 5.14). The line is always shown;
 * the disclosure is closed by default so the page leads with the figures.
 */
export function RunIdentity({ identity, inputChangeNote }: RunIdentityProps) {
  const rows: Array<[string, string]> = [
    ["Run key", identity.runKey],
    ["Input hash", identity.inputHash],
    ["Output hash", identity.outputHash],
    ["Recipe", [identity.recipeId, identity.recipeHash].filter(Boolean).join(" ")],
    ["Engine", identity.engineVersion],
    ["Window", identity.windowStart && identity.windowEnd ? `${shortDate(identity.windowStart)} to ${shortDate(identity.windowEnd)}` : ""],
    ["Returns", identity.returns],
    ["Benchmark", identity.benchmark],
    ["Fundamentals", identity.fundamentals],
    ["Prices through", shortDate(identity.pricesThrough)],
    ["ASIC report through", shortDate(identity.asicReportThrough)],
    ["Rules frozen (in-sample until)", shortDate(identity.inSampleUntil)],
    ["Risk-free rate", identity.riskFree],
    ["Build", identity.buildRevision],
  ].filter((row): row is [string, string] => row[1] !== "");
  return (
    <details className="group rounded-md border border-border/60 text-sm" data-run-identity>
      <summary className="cursor-pointer list-none px-3 py-2 font-mono text-xs text-muted-foreground hover:text-foreground">
        {runIdentityLine(identity)}
      </summary>
      <div className="space-y-3 border-t border-border/60 px-3 py-3">
        <p className="font-mono text-xs">{runIdentityDetail(identity)}</p>
        <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 font-mono text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
        {inputChangeNote ? (
          <p className="text-xs" data-input-change>
            <span className="font-medium">Changed since the previous run: </span>
            {inputChangeNote}
          </p>
        ) : null}
      </div>
    </details>
  );
}
