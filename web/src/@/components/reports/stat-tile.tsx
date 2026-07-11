import { cn } from "~/@/lib/utils";

/**
 * Calm, consistent stat tile for report pages: muted surface, ink value,
 * tabular numerals, and a small colour-coded delta arrow. Replaces the
 * previous rainbow-gradient tiles — colour is reserved for the delta
 * (red = short interest rising, green = falling).
 */

interface StatTileProps {
  label: string;
  value: string;
  /** Secondary line under the value, e.g. a stock code */
  sub?: string;
  /**
   * Signed delta rendered as a small arrow + number. Positive = red
   * (short interest rising = risk), negative = green.
   */
  delta?: number;
  /** Suffix appended to the delta, e.g. "%" */
  deltaSuffix?: string;
  className?: string;
}

export function StatTile({
  label,
  value,
  sub,
  delta,
  deltaSuffix = "",
  className,
}: StatTileProps) {
  const deltaValue =
    typeof delta === "number" && Number.isFinite(delta) ? delta : undefined;
  const rising = deltaValue !== undefined && deltaValue > 0.005;
  const falling = deltaValue !== undefined && deltaValue < -0.005;

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-card/50 p-4",
        className,
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
          {value}
        </span>
        {deltaValue !== undefined && (
          <span
            className={cn(
              "inline-flex items-baseline gap-0.5 text-xs font-medium tabular-nums",
              rising && "text-red-500",
              falling && "text-green-600",
              !rising && !falling && "text-muted-foreground",
            )}
          >
            <span aria-hidden="true" className="text-[9px] leading-none">
              {rising ? "▲" : falling ? "▼" : "–"}
            </span>
            {deltaValue > 0 ? "+" : ""}
            {deltaValue.toFixed(2)}
            {deltaSuffix}
          </span>
        )}
      </div>
      {sub && (
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {sub}
        </div>
      )}
    </div>
  );
}
