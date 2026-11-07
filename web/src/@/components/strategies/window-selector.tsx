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
  /** The ids the run carries; a window it does not carry is shown disabled, not hidden. */
  available: readonly BacktestWindowId[];
  /** The accessible name of the group. */
  label?: string;
}

/**
 * The four windows of 5.8 as a native radio group: one tab stop, arrow keys move and select
 * (the browser's own radio behaviour), and the choice is the form value, so no key handler
 * is needed. A window the run does not carry is disabled with the reason beside it.
 */
export function WindowSelector({
  value,
  onChange,
  available,
  label = "Window",
}: WindowSelectorProps) {
  return (
    <fieldset className="flex flex-wrap items-center gap-1 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      {BACKTEST_WINDOWS.map((window) => {
        const selected = window.id === value;
        const enabled = available.includes(window.id);
        return (
          <label
            key={window.id}
            className={cn(
              "relative cursor-pointer rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary",
              selected
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border/70 text-muted-foreground hover:text-foreground",
              !enabled && "cursor-not-allowed opacity-50",
            )}
          >
            <input
              type="radio"
              name="backtest-window"
              value={window.id}
              checked={selected}
              disabled={!enabled}
              onChange={() => onChange(window.id)}
              className="sr-only"
              data-window={window.id}
            />
            {window.label}
          </label>
        );
      })}
    </fieldset>
  );
}
