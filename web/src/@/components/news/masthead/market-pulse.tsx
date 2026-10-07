import Link from "next/link";
import { getTopShortsSummary } from "~/app/actions/getTopShorts";

/**
 * MarketPulse — a single horizontal "ticker" strip of the most shorted
 * ASX stocks, rendered under the masthead.
 *
 * Defensive by design: any fetch failure renders nothing — the strip must
 * never break the front page.
 */
export async function MarketPulse() {
  let stocks: { code: string; percent: number }[] = [];
  try {
    // withRetryAndNotFound already swallows errors (returns undefined),
    // but belt-and-braces: never let this strip take the page down.
    //
    // summary_only through the ISR-cacheable client: this strip needs six
    // codes and their latest figure, not time series, and /news is ISR — a
    // fetch Next cannot data-cache marks the regeneration dynamic and Vercel
    // then keeps the stale copy (2026-10-07: /news sat on a pre-publication
    // render while revalidation reported success).
    const resp = await getTopShortsSummary("3m", 6);
    stocks = (resp?.timeSeries ?? [])
      .filter((t) => Boolean(t.productCode))
      .slice(0, 6)
      .map((t) => ({
        code: t.productCode,
        percent: t.latestShortPosition,
      }));
  } catch {
    return null;
  }

  if (stocks.length === 0) return null;

  return (
    <div className="flex items-center gap-6 overflow-x-auto border-y border-border px-1 py-2">
      <span className="shrink-0 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        Most Shorted
      </span>
      {stocks.map((s) => (
        <Link
          key={s.code}
          href={`/shorts/${s.code}`}
          className="flex shrink-0 items-baseline gap-1.5 transition-opacity hover:opacity-80"
        >
          <span className="font-mono text-xs font-semibold">{s.code}</span>
          <span className="font-mono text-xs text-primary">
            {s.percent.toFixed(1)}%
          </span>
        </Link>
      ))}
    </div>
  );
}
