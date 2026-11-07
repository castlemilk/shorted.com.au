import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { NOT_AVAILABLE, formatSigned } from "@/lib/strategies/format";
import {
  RETURNS_INK,
  RETURNS_PLAIN_INK,
  binFill,
  coverageHatched,
  coverageKnown,
  printedReturn,
  returnBin,
  returnsLegend,
  type ReturnsScale,
} from "@/lib/strategies/returns-scale";

/**
 * A heatmap cell: a return in percent (12.3 is +12.3%), or a state with no figure,
 * which is hatched and carries its own words ("Run required", "Not elapsed", "Before
 * window", "Not computable before FY2024"). A `title` gives the cell's full copy on hover.
 */
export type ReturnsHeatmapCell =
  | {
      state: "value";
      /** The return, in percent. */
      value: number;
      /** The share of the names measured, 0 to 1. Under 80% the coverage line is hatched. */
      coverage?: number | null;
      /** The coverage line's title (the low-coverage copy, 1.7). */
      coverageTitle?: string;
      /** A glyph after the figure, named for a screen reader and given as a title (e.g. "?"). */
      marker?: { glyph: string; label: string; title?: string };
    }
  | {
      state: "hatched";
      label: string;
      /** How many columns the cell covers, from its own column on. Default 1. */
      span?: number;
      /** The cell's full copy, on hover and for a pointer. */
      title?: string;
    };

export interface ReturnsHeatmapColumn {
  key: string;
  label: string;
  /** A line under the header, e.g. "from 1 May" for a first year that starts part way through. */
  note?: string;
}

/** A window metric shown after the year columns (CAGR, max drawdown, the live track). */
export interface ReturnsHeatmapMetric {
  key: string;
  /** A line under the figure, e.g. "total return, not annualised". */
  note?: string;
  /** The figure as printed. Negative figures are set in the red text token, never in a fill. */
  text: string;
  value: number | null;
}

export interface ReturnsHeatmapRow {
  key: string;
  /** The name as drawn: text, or a control that selects the row. */
  name: ReactNode;
  /** A line under the name, e.g. the strategy's short profile. */
  sublabel?: string;
  cells: ReturnsHeatmapCell[];
  metrics?: ReturnsHeatmapMetric[];
  /** The cell before the name (a selection checkbox, say); drawn only when the table has a `leading` header. */
  lead?: ReactNode;
  /** The row the rail shows: framed. */
  selected?: boolean;
}

export interface ReturnsHeatmapTableProps {
  /** The table's caption: what the figures are. Visible, read first by everyone. */
  caption: string;
  /** The first column's header. */
  rowHeader: string;
  scale: ReturnsScale;
  columns: ReturnsHeatmapColumn[];
  rows: ReturnsHeatmapRow[];
  /** The window metric columns, after the year columns. */
  metricColumns?: ReturnsHeatmapColumn[];
  /** A column before the row names. Its header is read by a screen reader only. */
  leading?: { header: string };
}

// The figures are 11 px in a tight cell, so eight years and three metrics fit a 1280 px desk
// beside the rail. Every cell may wrap; a figure never wraps (tabular, one line).
const CELL = "px-1 py-1 text-right text-[11px] tabular-nums";
/** The name column: sticky at the left edge, so a signed-in sidebar or a phone keeps the names in view. */
const NAME_CELL = "sticky left-0 z-[1] bg-card px-1.5 py-1 text-left font-normal";
const LEAD_CELL = "sticky left-0 z-[1] w-8 bg-card px-1 py-1 align-middle";
const NAME_LEFT_WITH_LEAD = "left-8";

function ValueCell({
  value,
  coverage,
  coverageTitle,
  marker,
  scale,
  colKey,
}: {
  value: number;
  coverage?: number | null;
  coverageTitle?: string;
  marker?: { glyph: string; label: string; title?: string };
  scale: ReturnsScale;
  colKey: string;
}) {
  // The fill follows the figure as printed, so a cell's colour and its text agree.
  const bin = returnBin(printedReturn(value), scale);
  const fill = bin ? binFill(bin) : null;
  const hatched = coverageHatched(coverage);
  return (
    <td
      data-col={colKey}
      className={CELL}
      data-bin={bin?.key}
      style={{
        background: fill ?? undefined,
        color: fill ? RETURNS_INK : RETURNS_PLAIN_INK,
      }}
    >
      <span>{formatSigned(value, "%")}</span>
      {marker ? (
        <span title={marker.title ?? marker.label} className="ml-0.5">
          <span aria-hidden="true">{marker.glyph}</span>
          <span className="sr-only">{marker.label}</span>
        </span>
      ) : null}
      {coverageKnown(coverage) ? (
        <span
          title={coverageTitle}
          data-coverage-hatched={hatched ? "" : undefined}
          className={cn(
            "block px-0.5 font-mono text-[10px] leading-tight",
            // Over a fill the hatch is stripes only, so the ink keeps its contrast.
            hatched && (fill ? "hatch-on-fill" : "hatch-empty"),
          )}
        >
          cov {Math.round(coverage * 100)}%
        </span>
      ) : null}
    </td>
  );
}

function HatchedCell({
  label,
  span,
  title,
  colKey,
}: {
  label: string;
  span: number;
  title?: string;
  colKey: string;
}) {
  return (
    <td
      data-col={colKey}
      colSpan={span > 1 ? span : undefined}
      title={title}
      className={cn(CELL, "hatch-empty whitespace-normal text-center text-[10px] leading-tight")}
      data-state="hatched"
      style={{ color: RETURNS_PLAIN_INK }}
    >
      {label}
    </td>
  );
}

/** A window figure: negative in the red text token, never in a fill. The note wraps under it. */
function MetricCell({ metric }: { metric: ReturnsHeatmapMetric }) {
  const negative = metric.value !== null && metric.value < 0;
  return (
    <td
      className={cn(CELL, "whitespace-normal")}
      style={negative ? { color: "var(--semantic-red-text)" } : undefined}
    >
      {metric.text}
      {metric.note ? (
        <span className="block font-mono text-[10px] leading-tight text-muted-foreground">
          {metric.note}
        </span>
      ) : null}
    </td>
  );
}

/**
 * A returns heatmap as a real table: a visible caption, scoped headers, figures
 * right-aligned in tabular numerals, and each cell's ink on a tint of the signal
 * (returns-scale.ts). Server-rendered; it holds no state and no script. The scroll
 * wrapper is `relative`, so an sr-only label inside a cell stays in the wrapper and
 * cannot widen the page (the sr-only box is absolutely positioned). The wrapper takes
 * keyboard focus, so a narrow screen's later columns can be reached without a pointer.
 */
export function ReturnsHeatmapTable({
  caption,
  rowHeader,
  scale,
  columns,
  rows,
  metricColumns = [],
  leading,
}: ReturnsHeatmapTableProps) {
  const nameLeft = leading ? NAME_LEFT_WITH_LEAD : "";
  return (
    <div
      role="region"
      aria-label={caption}
      data-heatmap-scroll=""
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A scroll region needs focus for arrow-key scrolling.
      tabIndex={0}
      className="relative max-w-full overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <table className="w-full border-collapse text-xs">
        <caption className="mb-2 text-left font-mono text-xs text-muted-foreground">
          {caption}
        </caption>
        <thead>
          <tr>
            {leading ? (
              <th scope="col" className={cn("sticky left-0 z-[1] w-8 bg-card px-1 py-1 font-normal")}>
                <span className="sr-only">{leading.header}</span>
              </th>
            ) : null}
            <th
              scope="col"
              className={cn("bg-card px-1.5 py-1 text-left font-mono font-normal text-muted-foreground", leading ? "sticky left-8 z-[1]" : "sticky left-0 z-[1]")}
            >
              {rowHeader}
            </th>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className="px-1 py-1 text-right font-mono text-[11px] font-normal text-muted-foreground tabular-nums"
              >
                {c.label}
                {c.note ? (
                  <span className="block text-[10px] font-normal leading-tight">{c.note}</span>
                ) : null}
              </th>
            ))}
            {metricColumns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className="px-1 py-1 text-right font-mono text-[11px] font-normal text-muted-foreground tabular-nums"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            // A cell covers `span` columns from the column it starts in, so the
            // cells after a merged one stay under their own headers.
            let col = 0;
            const cells = row.cells.map((cell) => {
              const start = col;
              const span =
                cell.state === "hatched" ? Math.max(1, cell.span ?? 1) : 1;
              col += span;
              const colKey = columns[start]?.key ?? `col-${start}`;
              return cell.state === "value" ? (
                <ValueCell
                  key={colKey}
                  colKey={colKey}
                  value={cell.value}
                  coverage={cell.coverage}
                  coverageTitle={cell.coverageTitle}
                  marker={cell.marker}
                  scale={scale}
                />
              ) : (
                <HatchedCell
                  key={colKey}
                  colKey={colKey}
                  label={cell.label}
                  span={span}
                  title={cell.title}
                />
              );
            });
            return (
              <tr
                key={row.key}
                data-selected={row.selected ? "" : undefined}
                className={cn(
                  "border-t border-border/60",
                  row.selected && "outline outline-2 -outline-offset-2 outline-primary",
                )}
              >
                {leading ? <td className={LEAD_CELL}>{row.lead ?? null}</td> : null}
                <th scope="row" className={cn(NAME_CELL, nameLeft)}>
                  <span className="block whitespace-nowrap">{row.name}</span>
                  {row.sublabel ? (
                    <span className="block whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                      {row.sublabel}
                    </span>
                  ) : null}
                </th>
                {cells}
                {metricColumns.map((c) => {
                  const metric = row.metrics?.find((m) => m.key === c.key);
                  return metric ? (
                    <MetricCell key={c.key} metric={metric} />
                  ) : (
                    <td key={c.key} className={CELL}>
                      {NOT_AVAILABLE}
                    </td>
                  );
                })}
              </tr>
            );
          })}
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
