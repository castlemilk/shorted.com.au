import { cn } from "@/lib/utils";
import { formatSigned } from "@/lib/strategies/format";
import {
  RETURNS_INK,
  RETURNS_PLAIN_INK,
  binFill,
  coverageHatched,
  returnBin,
  returnsLegend,
  type ReturnsScale,
} from "@/lib/strategies/returns-scale";

/**
 * A heatmap cell: a return in percent (12.3 is +12.3%), or a state with no
 * figure, which is hatched and carries its own words ("Run required", "Not
 * elapsed", "Before window", "Not computable before 2025").
 */
export type ReturnsHeatmapCell =
  | {
      state: "value";
      /** The return, in percent. */
      value: number;
      /** The share of the names measured, 0 to 1. Under 80% the cell's coverage line is hatched. */
      coverage?: number | null;
      /** A glyph after the figure, named for a screen reader (e.g. "?" with "Coverage on ASIC-reported names only"). */
      marker?: { glyph: string; label: string };
    }
  | { state: "hatched"; label: string };

export interface ReturnsHeatmapColumn {
  key: string;
  label: string;
}

/** A window metric shown after the year columns (CAGR, max drawdown). */
export interface ReturnsHeatmapMetric {
  key: string;
  /** The figure as printed. Negative figures are set in the red text token. */
  text: string;
  value: number | null;
}

export interface ReturnsHeatmapRow {
  key: string;
  name: string;
  /** A line under the name, e.g. the strategy's breakout family. */
  sublabel?: string;
  cells: ReturnsHeatmapCell[];
  metrics?: ReturnsHeatmapMetric[];
}

export interface ReturnsHeatmapTableProps {
  /** The table's caption: what the figures are, read first by everyone. */
  caption: string;
  /** The first column's header. */
  rowHeader: string;
  scale: ReturnsScale;
  columns: ReturnsHeatmapColumn[];
  rows: ReturnsHeatmapRow[];
  /** The window metric columns, after the year columns. */
  metricColumns?: ReturnsHeatmapColumn[];
}

const CELL = "px-1.5 py-1 text-right tabular-nums whitespace-nowrap";

function ValueCell({
  value,
  coverage,
  marker,
  scale,
}: {
  value: number;
  coverage?: number | null;
  marker?: { glyph: string; label: string };
  scale: ReturnsScale;
}) {
  const bin = returnBin(value, scale);
  const fill = bin ? binFill(bin) : null;
  const hatched = coverageHatched(coverage);
  return (
    <td
      className={CELL}
      data-bin={bin?.key}
      style={{
        background: fill ?? undefined,
        color: fill ? RETURNS_INK : RETURNS_PLAIN_INK,
      }}
    >
      <span>{formatSigned(value, "%")}</span>
      {marker ? (
        <>
          <span aria-hidden="true" className="ml-0.5">
            {marker.glyph}
          </span>
          <span className="sr-only">{marker.label}</span>
        </>
      ) : null}
      {coverage != null ? (
        <span
          data-coverage-hatched={hatched ? "" : undefined}
          className={cn(
            "block px-0.5 font-mono text-[10px] leading-tight",
            hatched && "hatch-empty",
          )}
        >
          cov {Math.round(coverage * 100)}%
        </span>
      ) : null}
    </td>
  );
}

function HatchedCell({ label }: { label: string }) {
  return (
    <td
      className={cn(CELL, "hatch-empty")}
      data-state="hatched"
      style={{ color: RETURNS_PLAIN_INK }}
    >
      {label}
    </td>
  );
}

/** A window figure: negative in the red text token, never in a fill. */
function MetricCell({ metric }: { metric: ReturnsHeatmapMetric }) {
  const negative = metric.value !== null && metric.value < 0;
  return (
    <td
      className={CELL}
      style={negative ? { color: "var(--semantic-red-text)" } : undefined}
    >
      {metric.text}
    </td>
  );
}

/**
 * A returns heatmap as a real table: a caption, scoped headers, figures
 * right-aligned in tabular numerals, and each cell's ink on a tint of the signal
 * (returns-scale.ts). Server-rendered; it holds no state and no script.
 */
export function ReturnsHeatmapTable({
  caption,
  rowHeader,
  scale,
  columns,
  rows,
  metricColumns = [],
}: ReturnsHeatmapTableProps) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <caption className="mb-2 text-left font-mono text-xs text-muted-foreground">
          {caption}
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="px-1.5 py-1 text-left font-mono font-normal text-muted-foreground"
            >
              {rowHeader}
            </th>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className="px-1.5 py-1 text-right font-mono font-normal text-muted-foreground tabular-nums"
              >
                {c.label}
              </th>
            ))}
            {metricColumns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className="px-1.5 py-1 text-right font-mono font-normal text-muted-foreground tabular-nums"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border/60">
              <th scope="row" className="px-1.5 py-1 text-left font-normal">
                <span className="block">{row.name}</span>
                {row.sublabel ? (
                  <span className="block font-mono text-[10px] text-muted-foreground">
                    {row.sublabel}
                  </span>
                ) : null}
              </th>
              {row.cells.map((cell, i) =>
                cell.state === "value" ? (
                  <ValueCell
                    key={columns[i]?.key ?? i}
                    value={cell.value}
                    coverage={cell.coverage}
                    marker={cell.marker}
                    scale={scale}
                  />
                ) : (
                  <HatchedCell key={columns[i]?.key ?? i} label={cell.label} />
                ),
              )}
              {metricColumns.map((c) => {
                const metric = row.metrics?.find((m) => m.key === c.key);
                return metric ? (
                  <MetricCell key={c.key} metric={metric} />
                ) : (
                  <td key={c.key} className={CELL} />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The five bins as swatches with their words, read beside the table. */
export function ReturnsLegend({ scale }: { scale: ReturnsScale }) {
  const words = returnsLegend(scale);
  const swatches = [
    { key: "strong-down", value: scale === "annual" ? -20 : -8 },
    { key: "down", value: scale === "annual" ? -3 : -2 },
    { key: "flat", value: 0 },
    { key: "up", value: scale === "annual" ? 3 : 2 },
    { key: "strong-up", value: scale === "annual" ? 20 : 8 },
  ];
  return (
    <ul
      className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground"
      aria-label="Colour scale"
    >
      {swatches.map((s, i) => {
        const bin = returnBin(s.value, scale);
        const fill = bin ? binFill(bin) : null;
        return (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn(
                "inline-block h-3 w-3 rounded-sm border border-border",
                !fill && "bg-card",
              )}
              style={fill ? { background: fill } : undefined}
            />
            <span>{words[i]}</span>
          </li>
        );
      })}
    </ul>
  );
}
