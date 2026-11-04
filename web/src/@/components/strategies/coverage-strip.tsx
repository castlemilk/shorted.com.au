import { cn } from "@/lib/utils";
import {
  coverageFraction,
  coverageHatched,
  COVERAGE_HATCH_BELOW,
} from "@/lib/strategies/returns-scale";

export interface CoverageStripItem {
  key: string;
  /** The period the bar stands for, e.g. "2019" or "Mar 2023". */
  label: string;
  /** The share of the names measured, 0 to 1. Null when not known: no bar, the word "n/a". */
  coverage: number | null;
}

export interface CoverageStripProps {
  /** Names the list for a screen reader, e.g. "Coverage by year". */
  label: string;
  items: CoverageStripItem[];
}

/**
 * How much of the universe a backtest could price, period by period, as an HTML
 * list of bars (not SVG, so it reads and prints as text). A bar under 80% is
 * hatched and its figure says so: a backtest that flatters on thin coverage
 * must show that where it is read.
 */
export function CoverageStrip({ label, items }: CoverageStripProps) {
  return (
    <ol aria-label={label} className="space-y-1">
      {items.map((item) => {
        const f = coverageFraction(item.coverage);
        const hatched = coverageHatched(item.coverage);
        const pct = item.coverage === null ? null : Math.round(f * 100);
        return (
          <li
            key={item.key}
            data-hatched={hatched ? "" : undefined}
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
                  hatched ? "hatch-empty" : "bg-muted-foreground/60",
                )}
                style={{ width: `${f * 100}%` }}
              />
              <span
                className="absolute inset-y-0 w-px bg-foreground/50"
                style={{ left: `${COVERAGE_HATCH_BELOW * 100}%` }}
              />
            </span>
            <span className="text-right">
              {pct === null ? "n/a" : `${pct}%`}
              {hatched ? <span className="sr-only"> (under 80%)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
