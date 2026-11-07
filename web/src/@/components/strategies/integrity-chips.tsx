import { cn } from "@/lib/utils";

export interface IntegrityChipsProps {
  /** The chips in reading order; each is words, never a colour of direction (1.8). */
  chips: readonly string[];
  className?: string;
}

/**
 * The honesty chips the Backtest tab prints above its charts (1.5, 1.8). They are
 * never gated by tier and never red or green: a chip states a condition, and the
 * condition's words carry the meaning. Outline badges, so they read as labels.
 */
export function IntegrityChips({ chips, className }: IntegrityChipsProps) {
  if (chips.length === 0) return null;
  return (
    <ul aria-label="About this backtest" className={cn("flex flex-wrap gap-1.5", className)}>
      {chips.map((chip) => (
        <li
          key={chip}
          className="rounded-sm border border-foreground/30 px-2 py-0.5 font-mono text-[11px] leading-snug text-foreground"
        >
          {chip}
        </li>
      ))}
    </ul>
  );
}
