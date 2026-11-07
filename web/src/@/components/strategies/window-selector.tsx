import { cn } from "@/lib/utils";
import {
  BACKTEST_WINDOWS,
  type BacktestWindowId,
} from "@/lib/strategies/backtest-windows";

export interface WindowSelectorProps {
  /** The window the page shows. */
  value: BacktestWindowId;
  /** Called with the window the reader picked. */
  onChange: (next: BacktestWindowId) => void;
  /** The ids the run carries; a window it does not carry is shown disabled. */
  available: readonly BacktestWindowId[];
  /** The accessible name. */
  label?: string;
}

/**
 * The four windows of 5.8 as a segmented control. A window the run does not
 * carry is disabled, never hidden, so the reader sees the four and why one is
 * absent (a run with no live tail has no "Live since freeze").
 */
export function WindowSelector({
  value,
  onChange,
  available,
  label = "Window",
}: WindowSelectorProps) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {BACKTEST_WINDOWS.map((window) => {
        const selected = window.id === value;
        const enabled = available.includes(window.id);
        return (
          <button
            key={window.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={!enabled}
            data-window={window.id}
            onClick={() => enabled && onChange(window.id)}
            className={cn(
              "rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors",
              selected
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border/70 text-muted-foreground hover:text-foreground",
              !enabled && "cursor-not-allowed opacity-50 hover:text-muted-foreground",
            )}
          >
            {window.label}
          </button>
        );
      })}
    </div>
  );
}
