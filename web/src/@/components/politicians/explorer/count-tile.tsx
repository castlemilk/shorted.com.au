export interface CountTileDelta {
  count: number;
  periodLabel: string;
}

export interface CountTileProps {
  count: number;
  label: string;
  delta?: CountTileDelta;
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

export function CountTile({ count, label, delta }: CountTileProps) {
  return (
    <article className="rounded-lg border bg-card p-4">
      <div className="text-2xl font-semibold tabular-nums text-foreground">
        {groupDigits(safeCount(count))}
      </div>
      {/*
        `break-words` because the label is the part that gets clipped, not the
        number: "319 parliamentarians" lost its final "s" in a two-column grid at
        375 px. A label that wraps to two lines is right; a label that silently
        loses a character is a different word.
      */}
      <div className="text-xs text-muted-foreground break-words">{label}</div>
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
