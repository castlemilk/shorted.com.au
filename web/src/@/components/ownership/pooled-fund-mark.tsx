// A fund row whose figures are a pooled wholesale fund's, not the ETF's alone.
// The mark is a letter, and its meaning is the text a screen reader reads: the
// house never marks a source with colour (DESIGN.md).

/** What the P stands for, for a screen reader (copy pooled.sr). */
export const POOLED_MARK_SR = "pooled wholesale fund, not the ETF alone";

export function PooledFundMark() {
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[2px] border border-muted-foreground text-[10px] font-semibold leading-none text-muted-foreground">
      <span aria-hidden="true">P</span>
      <span className="sr-only">{POOLED_MARK_SR}</span>
    </span>
  );
}
