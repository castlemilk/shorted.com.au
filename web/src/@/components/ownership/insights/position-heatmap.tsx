"use client";

/**
 * Position changes by sector (rows) and week or month (columns). Under the index
 * funds measure a cell is the change in shares the index funds hold over the
 * bucket, each fund compared with its own earlier file and valued at the later
 * file's price; under disclosed stakes it is the net change in voting power the
 * bucket's notices state. A hatched cell is a bucket no fund filed a newer file
 * in: n/a, not zero. A blank cell is a bucket with no notice.
 *
 * Built as a table of buttons, so every cell is reachable by keyboard and named
 * for a screen reader with its figures. Pressing a cell drills into the stocks
 * and holders behind it.
 */

import { useMemo, useState } from "react";

import { bucketLabel, formatPp, formatSignedAud, sectorLabel } from "~/@/lib/ownership/insights/format";
import { BIN_STYLES, NA_STYLE, divergingBin, divergingDomain } from "~/@/lib/ownership/insights/scale";
import type { InsightHeatCellRow, InsightHeatmapRow, InsightMeasure } from "~/@/lib/ownership/insights/types";
import { cn } from "~/@/lib/utils";

import { ChangeLegend } from "./insights-parts";

export interface HeatCellRef {
  bucket: number;
  sector: string;
}

export interface PositionHeatmapProps {
  heatmap: InsightHeatmapRow;
  measure: InsightMeasure;
  bucket: "week" | "month" | "";
  focusSector: string | null;
  selected: HeatCellRef | null;
  onSelect: (cell: HeatCellRef) => void;
}

const HATCH = "repeating-linear-gradient(135deg, transparent 0 3px, hsl(var(--muted-foreground) / 0.35) 3px 4px)";

/** The figure a cell is coloured by, or null when the bucket cannot state it. */
export function cellValue(cell: InsightHeatCellRow, measure: InsightMeasure): number | null {
  if (measure === "funds") return cell.fundFlow;
  return cell.notices > 0 ? cell.noticeNetPp : null;
}

export function cellText(cell: InsightHeatCellRow, measure: InsightMeasure): string {
  if (measure === "funds") {
    if (cell.fundFlow == null) return "n/a: no fund filed a newer file";
    return `${formatSignedAud(cell.fundFlow)} in shares held, ${cell.fundsCompared} funds compared`;
  }
  if (cell.notices === 0) return "no notice";
  const parts = [`${formatPp(cell.noticeNetPp)} net`, `${cell.notices} notices`];
  if (cell.rises) parts.push(`${cell.rises} rises`);
  if (cell.falls) parts.push(`${cell.falls} falls`);
  if (cell.became) parts.push(`${cell.became} became substantial`);
  if (cell.ceased) parts.push(`${cell.ceased} ceased`);
  return parts.join(", ");
}

export function PositionHeatmap({ heatmap, measure, bucket, focusSector, selected, onSelect }: PositionHeatmapProps) {
  const domain = useMemo(
    () => divergingDomain(heatmap.rows.flatMap((r) => r.cells.map((c) => cellValue(c, measure)))),
    [heatmap, measure],
  );
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);

  if (heatmap.rows.length === 0 || heatmap.buckets.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {measure === "funds"
          ? "No sector moved in this window: no index fund filed two files inside it."
          : "No notice dated inside this window."}
      </p>
    );
  }

  const hovered = hover ? heatmap.rows[hover.row] : undefined;
  const hoveredBucket = hover ? heatmap.buckets[hover.col] : undefined;
  const hoveredCell = hover && hovered ? hovered.cells[hover.col] : undefined;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto pb-1">
        <table className="w-full border-separate border-spacing-[2px] text-[10px]">
          <caption className="sr-only">
            {measure === "funds"
              ? "Change in the shares index funds hold, by sector and bucket. Press a cell for its stocks and holders."
              : "Net change in voting power the notices state, by sector and bucket. Press a cell for its stocks and holders."}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-[1] w-[9.5rem] bg-background px-1 text-left font-normal text-muted-foreground">
                <span className="sr-only">Sector</span>
              </th>
              {heatmap.buckets.map((b) => (
                <th key={b.start} scope="col" className="h-[52px] min-w-[26px] p-0 align-bottom font-normal">
                  <time
                    dateTime={b.start}
                    title={`${b.start} to ${b.end}`}
                    className="inline-block rotate-180 whitespace-nowrap text-muted-foreground tabular-nums [writing-mode:vertical-rl]"
                  >
                    {bucketLabel(b.start, bucket)}
                  </time>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {heatmap.rows.map((row, ri) => {
              const isFocus = focusSector !== null && row.sector === focusSector;
              return (
                <tr key={row.sector}>
                  <th
                    scope="row"
                    className={cn(
                      "sticky left-0 z-[1] max-w-[9.5rem] truncate bg-background pr-2 text-left text-[11px] font-normal",
                      isFocus ? "font-semibold text-primary" : "text-foreground",
                    )}
                    title={row.label}
                  >
                    {row.label}
                  </th>
                  {row.cells.map((cell, ci) => {
                    const value = cellValue(cell, measure);
                    const bin = divergingBin(value, domain);
                    const b = heatmap.buckets[ci]!;
                    const empty = measure === "disclosed" && cell.notices === 0;
                    const isSelected = selected?.bucket === ci && selected.sector === row.sector;
                    return (
                      <td key={ci} className="p-0">
                        <button
                          type="button"
                          aria-label={`${sectorLabel(row.sector)}, ${b.start} to ${b.end}: ${cellText(cell, measure)}`}
                          aria-pressed={isSelected}
                          onClick={() => onSelect({ bucket: ci, sector: row.sector })}
                          onPointerEnter={() => setHover({ row: ri, col: ci })}
                          onPointerLeave={() => setHover(null)}
                          onFocus={() => setHover({ row: ri, col: ci })}
                          onBlur={() => setHover(null)}
                          className={cn(
                            "block h-7 w-full min-w-[26px] rounded-[3px] transition-[box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            empty ? "bg-muted/40" : bin == null ? NA_STYLE.swatch : BIN_STYLES[bin].swatch,
                            isSelected && "ring-2 ring-primary",
                          )}
                          style={!empty && bin == null ? { backgroundImage: HATCH } : undefined}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="min-h-[1.25rem] text-[11px] text-muted-foreground" aria-hidden>
        {hovered && hoveredBucket && hoveredCell ? (
          <>
            <span className="font-medium text-foreground">{hovered.label}</span>,{" "}
            <time dateTime={hoveredBucket.start}>{hoveredBucket.start}</time> to{" "}
            <time dateTime={hoveredBucket.end}>{hoveredBucket.end}</time>: {cellText(hoveredCell, measure)}
          </>
        ) : (
          "Hover or focus a cell for its figures; press it for the stocks and holders behind it."
        )}
      </p>
      <ChangeLegend
        measure={measure}
        domain={domain}
        title={
          measure === "funds"
            ? "Colour: change in shares the index funds hold, valued at the later file's price, AUD."
            : "Colour: net change in voting power the bucket's notices state, percentage points summed over notices."
        }
        naText={measure === "funds" ? "n/a: no newer file that bucket" : undefined}
        naOnly={measure === "funds" && heatmap.rows.every((r) => r.cells.every((c) => c.fundFlow == null))}
        formatValue={measure === "funds" ? (v) => formatSignedAud(v) : undefined}
      />
      {measure === "disclosed" ? (
        <p className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span aria-hidden className="inline-block h-3 w-3 rounded-sm bg-muted/40" /> no notice in the bucket
        </p>
      ) : null}
    </div>
  );
}
