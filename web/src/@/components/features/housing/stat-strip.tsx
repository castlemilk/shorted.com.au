import { cn } from "@/lib/utils";
import type { FeatureStat } from "./data/types";
import { Cite } from "./cite";

const toneClass: Record<NonNullable<FeatureStat["tone"]>, string> = {
  up: "text-[color:var(--semantic-green)]",
  down: "text-[color:var(--semantic-red)]",
  neutral: "text-primary",
};

/**
 * A row of headline figures. Hairline-separated cells on a single bordered
 * surface; values in tabular mono, labels carrying their citation.
 */
export function StatStrip({
  stats,
  className,
}: {
  stats: FeatureStat[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-px overflow-hidden rounded-xl border border-border bg-border",
        stats.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2",
        className,
      )}
    >
      {stats.map((s, i) => (
        <div key={i} className="bg-card p-5 sm:p-6">
          <div
            className={cn(
              "font-mono text-3xl font-semibold tabular-nums sm:text-4xl",
              s.tone ? toneClass[s.tone] : "text-primary",
            )}
          >
            {s.value}
          </div>
          <div className="mt-2 text-sm font-medium leading-snug text-foreground">
            {s.label}
            {s.sourceId ? <Cite id={s.sourceId} /> : null}
          </div>
          {s.context ? (
            <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {s.context}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
