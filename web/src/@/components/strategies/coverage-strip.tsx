import { cn } from "@/lib/utils";
import {
  coverageFraction,
  coverageHatched,
  coverageKnown,
  COVERAGE_HATCH_BELOW,
} from "@/lib/strategies/returns-scale";
import { NOT_AVAILABLE } from "@/lib/strategies/format";

export interface CoverageStripItem {
  key: string;
  /** The period the bar stands for, e.g. "2019" or "Mar 2023". */
  label: string;
  /** The share of the names measured, 0 to 1. Null (or NaN) when not known: no bar, the word "n/a". */
  coverage: number | null;
}

export interface CoverageStripProps {
  /** Names the list for a screen reader, e.g. "Coverage by year". */
  label: string;
  items: CoverageStripItem[];
  /**
   * "rows" (default): one labelled bar per period, down the page, for a short
   * list of years. "columns": one narrow bar per period in a single row, for a
   * long run of months under a chart; the period names are read, not shown.
   */
  layout?: "rows" | "columns";
}

/** The width of a bar, and whether it is hatched and how it is figured. */
function barOf(item: CoverageStripItem) {
  const known = coverageKnown(item.coverage);
  return {
    known,
    fraction: coverageFraction(item.coverage),
    hatched: coverageHatched(item.coverage),
    pct: known ? Math.round(coverageFraction(item.coverage) * 100) : null,
  };
}

/**
 * How much of the universe a backtest could price, period by period, as an HTML
 * list of bars (not SVG, so it reads and prints as text). A bar under 80% is
 * hatched and its figure says so: a backtest that flatters on thin coverage
 * must show that where it is read.
 */
export function CoverageStrip({
  label,
  items,
  layout = "rows",
}: CoverageStripProps) {
  if (layout === "columns") {
    return (
      <ol aria-label={label} className="flex h-6 items-end gap-px">
        {items.map((item) => {
          const bar = barOf(item);
          return (
            <li
              key={item.key}
              data-hatched={bar.hatched ? "" : undefined}
              className="relative h-full min-w-0 flex-1 overflow-hidden rounded-[1px] bg-muted"
              title={`${item.label}: ${bar.pct === null ? NOT_AVAILABLE : `${bar.pct}%`}`}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-x-0 bottom-0",
                  bar.hatched ? "hatch-bar" : "bg-muted-foreground/60",
                )}
                style={{ height: `${bar.fraction * 100}%` }}
              />
              <span className="sr-only">
                {item.label}: {bar.pct === null ? NOT_AVAILABLE : `${bar.pct}%`}
                {bar.hatched ? ` (under ${COVERAGE_HATCH_BELOW * 100}%)` : ""}
              </span>
            </li>
          );
        })}
      </ol>
    );
  }
  return (
    <ol aria-label={label} className="space-y-1">
      {items.map((item) => {
        const bar = barOf(item);
        return (
          <li
            key={item.key}
            data-hatched={bar.hatched ? "" : undefined}
            className="grid grid-cols-[4.5rem_minmax(0,1fr)_4.25rem] items-center gap-2 font-mono text-xs tabular-nums"
          >
            <span>{item.label}</span>
            <span
              className="relative block h-2.5 overflow-hidden rounded-sm bg-muted"
              aria-hidden="true"
            >
              <span
                className={cn(
                  "absolute inset-y-0 left-0",
                  bar.hatched ? "hatch-bar" : "bg-muted-foreground/60",
                )}
                style={{ width: `${bar.fraction * 100}%` }}
              />
              <span
                className="absolute inset-y-0 w-px bg-foreground/50"
                style={{ left: `${COVERAGE_HATCH_BELOW * 100}%` }}
              />
            </span>
            <span className="text-right">
              {bar.pct === null ? NOT_AVAILABLE : `${bar.pct}%`}
              {bar.hatched ? (
                <span className="sr-only"> (under 80%)</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
