import {
  ReturnsHeatmapTable,
  type ReturnsHeatmapRow,
} from "@/components/strategies/returns-heatmap-table";
import type { MonthlyReturnView } from "@/lib/strategies/map-backtest";
import {
  MONTH_NAMES,
  monthCells,
  monthlyYears,
  splitMonthlyYears,
} from "@/lib/strategies/backtest-tables";

export interface MonthlyReturnsTableProps {
  monthly: readonly MonthlyReturnView[];
  /** The strategy's name, for the table's caption. */
  strategyName: string;
  /** The run's window, YYYY-MM-DD: months outside it say "Before window" or "Not elapsed". */
  windowStart: string;
  windowEnd: string;
}

/**
 * The monthly returns of the since-May-2019 chain (design 1.5). The three newest
 * years show; the earlier years sit behind a disclosure, in the same table
 * markup. A month the run has no figure for says why in its cell (1.7).
 */
export function MonthlyReturnsTable({
  monthly,
  strategyName,
  windowStart,
  windowEnd,
}: MonthlyReturnsTableProps) {
  const years = monthlyYears(monthly);
  if (years.length === 0) {
    return <p className="text-sm text-muted-foreground">No monthly returns in this run.</p>;
  }
  const { recent, earlier } = splitMonthlyYears(years);
  const rowsFor = (list: readonly number[]): ReturnsHeatmapRow[] =>
    list.map((year) => ({
      key: String(year),
      name: String(year),
      cells: monthCells(monthly, year, windowStart, windowEnd).map((cell) =>
        cell.kind === "value"
          ? {
              state: "value" as const,
              value: cell.value,
              marker: cell.current ? { glyph: "*", label: "Month to date" } : undefined,
            }
          : { state: "hatched" as const, label: cell.label },
      ),
    }));
  const columns = MONTH_NAMES.map((name) => ({ key: name, label: name }));
  return (
    <div className="space-y-3">
      <ReturnsHeatmapTable
        caption={`${strategyName}: monthly returns, after costs (the newest three years)`}
        rowHeader="Year"
        scale="monthly"
        columns={columns}
        rows={rowsFor(recent)}
      />
      {earlier.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer font-mono text-xs text-muted-foreground hover:text-foreground">
            Earlier years ({earlier.length})
          </summary>
          <div className="pt-3">
            <ReturnsHeatmapTable
              caption={`${strategyName}: monthly returns, earlier years`}
              rowHeader="Year"
              scale="monthly"
              columns={columns}
              rows={rowsFor(earlier)}
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}
