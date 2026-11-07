import type { SensitivityView } from "@/lib/strategies/map-backtest";
import { sensitivityFigures } from "@/lib/strategies/backtest-tables";
import { NOT_AVAILABLE } from "@/lib/strategies/format";

export interface SensitivityTableProps {
  rows: readonly SensitivityView[];
}

/**
 * The sensitivity runs stored on every published run (5.12), shown to everyone.
 * A run that does not take a change says why in the row; a fragile result carries
 * its chip ("Fragile to costs") in words, never in red or green.
 */
export function SensitivityTable({ rows }: SensitivityTableProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No sensitivity runs are stored for this run.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] border-collapse text-sm">
        <caption className="sr-only">Sensitivity runs: each change, the CAGR it gives and its excess over the benchmark</caption>
        <thead>
          <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-3 font-medium">Change</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">CAGR</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Excess over benchmark</th>
            <th scope="col" className="py-2 font-medium">Reading</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const figures = sensitivityFigures(row);
            return (
              <tr key={row.id} className="border-b border-border/40 align-top">
                <th scope="row" className="py-2 pr-3 text-left font-normal">{row.label}</th>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">{figures.cagr}</td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">{figures.excess}</td>
                <td className="py-2 text-xs">
                  {!row.applies ? (
                    <span className="text-muted-foreground">{row.reason || "Not applicable to this recipe"}</span>
                  ) : row.fragile && row.fragileChip ? (
                    <span className="inline-flex rounded-sm border border-foreground/40 px-1.5 py-0.5 font-medium">
                      {row.fragileChip}
                    </span>
                  ) : row.excessVsBenchmarkPct === null ? (
                    <span className="text-muted-foreground">{NOT_AVAILABLE}</span>
                  ) : (
                    <span className="text-muted-foreground">Holds</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">Costs at 10 bps brokerage (min A$10) and 5 to 50 bps spread by liquidity, per side. The flat 10 + 5 bps alternative flatters small-cap breakouts.</p>
    </div>
  );
}
