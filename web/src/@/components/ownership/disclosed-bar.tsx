import { NOT_AVAILABLE, formatPct } from "~/@/lib/fundamentals/format";
import { kindInfo, kindRank } from "~/@/lib/ownership/kinds";
import { cn } from "~/@/lib/utils";

// Server-safe: no "use client", no Connect import.
//
// What the notices disclose, drawn as an outlined extent rather than a share of
// the company: there is no 100% track, because a sum of interests is not a
// slice of anything. The outline is the muted ink, not the control boundary
// token, which marks fields and must not be borrowed for a data bar.

/** One kind's share of a disclosed total. */
export interface DisclosedSegment {
  kind: string;
  pct: number;
  holders: number;
}

export interface DisclosedBarProps {
  segments: readonly DisclosedSegment[];
  /** The disclosed total the segments make up. */
  total: number;
  /** The figure the outlined track is drawn to: the track is total / scaleMax of the width. */
  scaleMax: number;
  showFigure?: boolean;
  caption?: string;
  className?: string;
}

// The gap between two segments: a card-coloured hairline on the right edge, so
// neighbours stay distinct whatever their contrast.
const GAP = "inset -1px 0 0 hsl(var(--card))";
// A hollow segment is outlined, so it reads as a share with no colour of its
// own rather than as a hole in the track.
const HOLLOW = `${GAP}, inset 0 0 0 1px hsl(var(--muted-foreground))`;
// "other" and every kind after it have no colour of their own (kinds.ts orders them last).
const HOLLOW_FROM = kindRank("other");

// Sums print to two decimals, as formatSum does in ownership-parts.tsx.
function sumOf(pct: number): string {
  return formatPct(pct, { digits: 2 });
}

function holdersOf(n: number): string {
  return `${n} ${n === 1 ? "holder" : "holders"}`;
}

export function DisclosedBar({
  segments,
  total,
  scaleMax,
  showFigure = true,
  caption,
  className,
}: DisclosedBarProps) {
  // A zero sum has no extent to draw, and "0.00%" would say it was measured.
  const hasSum = Number.isFinite(total) && total > 0;
  const extent = hasSum && scaleMax > 0 ? Math.min(total / scaleMax, 1) : 1;
  const shown = segments
    .filter((s) => s.pct > 0)
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
  const listed = shown
    .map((s) => `${kindInfo(s.kind).label} ${sumOf(s.pct)} (${holdersOf(s.holders)})`)
    .join(", ");
  const label = `Disclosed voting power ${sumOf(total)}, what the notices disclose and not a share of the company: ${listed}`;

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center gap-3">
        {hasSum ? (
          <div
            role="img"
            aria-label={label}
            className="flex h-2.5 min-w-[2px] shrink overflow-hidden rounded-[1px] border border-muted-foreground"
            style={{ width: `${extent * 100}%` }}
          >
            {shown.map((s, index) => {
              const hollow = kindRank(s.kind) >= HOLLOW_FROM;
              return (
                <span
                  key={`${s.kind}-${index}`}
                  aria-hidden="true"
                  title={`${kindInfo(s.kind).label}: ${sumOf(s.pct)} (${holdersOf(s.holders)})`}
                  className={cn("block h-full shrink-0", !hollow && kindInfo(s.kind).swatch)}
                  style={{ width: `${(s.pct / total) * 100}%`, boxShadow: hollow ? HOLLOW : GAP }}
                />
              );
            })}
          </div>
        ) : null}
        {showFigure ? (
          <span className="shrink-0 text-xs tabular-nums">{hasSum ? sumOf(total) : NOT_AVAILABLE}</span>
        ) : null}
      </div>
      {caption ? <p className="text-[11px] text-muted-foreground">{caption}</p> : null}
    </div>
  );
}
