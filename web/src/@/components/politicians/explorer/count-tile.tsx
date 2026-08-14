import { PoliticsIcon } from "@/components/politicians/politics-icon";
import type { PoliticsIconName } from "@/components/politicians/politics-icons.generated";

export interface CountTileDelta {
  count: number;
  periodLabel: string;
}

export interface CountTileProps {
  count: number;
  label: string;
  delta?: CountTileDelta;
  /**
   * The sprite id for whatever this tile counts, when the caller has one.
   *
   * OPTIONAL BY DESIGN. This is generic kit — it counts register entries on one
   * page and people on another — so an icon is something a caller supplies,
   * never something the tile derives from its label. Decorative: the label
   * beside it is the name, and PoliticsIcon is aria-hidden unless given a
   * `title`, so a reader on a screen reader hears the label once.
   */
  icon?: PoliticsIconName;
  /**
   * One quiet line of context under the label: what the count was drawn from,
   * or the span it covers.
   *
   * NOT a second `delta`. `delta` signs its count because it names a movement
   * across a stated period; `meta` is a standing fact and must never be signed.
   * A register change is an entry appearing or leaving the register, not a
   * transaction, so a "+" in front of one would read as growth nobody declared.
   * Counts and dates only — no amounts, no verdicts.
   */
  meta?: string;
  /**
   * Render as a segment of a joined KPI strip rather than a free-standing
   * card: the container owns the border and the corners, the cell owns only
   * its padding. Six separate cards with gaps between them read as six
   * floating objects; one segmented strip reads as one instrument.
   */
  flush?: boolean;
}

function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

/**
 * Thousands separators, in the reader's own locale.
 *
 * `17084` is a string of digits a reader has to count; `17,084` is a number they
 * can read at a glance. These tiles carry the corpus-scale figures on the hub —
 * the ones most likely to run into five digits — and they were the only place in
 * the feature printing them unseparated. `en-AU` is pinned rather than left to
 * the runtime so the server and the client agree: an unpinned locale renders one
 * way in the Node prerender and another in the browser, which is a hydration
 * mismatch on a statically-generated page.
 */
function groupDigits(count: number): string {
  return count.toLocaleString("en-AU");
}

function signedCount(count: number): string {
  const value = Number.isFinite(count) ? Math.trunc(count) : 0;
  if (value < 0) return `−${groupDigits(Math.abs(value))}`;
  return `+${groupDigits(value)}`;
}

export function CountTile({
  count,
  label,
  delta,
  icon,
  meta,
  flush,
}: CountTileProps) {
  return (
    <article className={flush ? "bg-card p-3" : "rounded-lg border bg-card p-4"}>
      <div className="text-3xl font-semibold tabular-nums tracking-tight text-foreground">
        {groupDigits(safeCount(count))}
      </div>
      {/*
        `break-words` rides on the TEXT, not on the row: the label is the part
        that gets clipped, not the number — "319 parliamentarians" lost its final
        "s" in a two-column grid at 375 px. A label that wraps to two lines is
        right; a label that silently loses a character is a different word. The
        row itself is a block-level flex line (not `inline-flex`) so it keeps the
        full column width and the tile's vertical rhythm: an inline box here
        would inherit the article's line-height strut and grow every tile. And
        `min-w-0` on the text, because a flex item's default `min-width: auto`
        is its longest word — that alone would put the same label back outside
        the tile, overflowing instead of wrapping.
      */}
      <div className="mt-0.5 flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon ? <PoliticsIcon name={icon} size={13} /> : null}
        <span className="min-w-0 break-words">{label}</span>
      </div>
      {/*
        Sits with the label because it describes what was counted; the delta
        stays last as the one line that moves. Unsigned, always — see `meta`.
      */}
      {meta ? (
        <div className="mt-1 text-[11px] tabular-nums text-muted-foreground">
          {meta}
        </div>
      ) : null}
      {delta ? (
        <div className="mt-1 flex gap-1 text-[11px] text-muted-foreground">
          <span className="tabular-nums text-muted-foreground">
            {signedCount(delta.count)}
          </span>
          <span>{delta.periodLabel}</span>
        </div>
      ) : null}
    </article>
  );
}
