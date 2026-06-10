import { Children } from "react";
import { cn } from "~/@/lib/utils";

export function StatGroup({ children }: { children: React.ReactNode }) {
  // Size the grid to the number of stats — a fixed 4-col grid leaves empty
  // tracks (visible as blank boxes) when the writer emits 2 or 3 stats.
  const count = Children.count(children);
  const cols =
    count <= 1
      ? "grid-cols-1"
      : count === 2
        ? "grid-cols-2"
        : count === 3
          ? "grid-cols-1 sm:grid-cols-3"
          : "grid-cols-2 md:grid-cols-4";
  return (
    <div className={cn("my-8 grid gap-px overflow-hidden rounded-lg border border-border bg-border", cols)}>
      {children}
    </div>
  );
}

export function Stat({ label, value, context, cite }: { label: string; value: string; context?: string; cite?: string }) {
  return (
    <div className="bg-card p-4">
      <div className="font-mono text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {context && <div className={cn("mt-1 text-xs text-muted-foreground/80")}>{context}</div>}
      {cite && (
        <sup className="text-[10px]">
          <a href={`#${cite}`} className="text-primary hover:underline" aria-label={`Source ${cite}`}>
            [{cite}]
          </a>
        </sup>
      )}
    </div>
  );
}
