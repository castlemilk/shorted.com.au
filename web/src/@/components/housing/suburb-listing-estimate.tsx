// Server component. The only price signal available for the ~11,700 suburbs with
// no Valuer-General feed.
//
// QLD, WA, TAS, NT and ACT publish no open suburb-level median, and every
// commercial alternative is licensed — so for those states this is it. It is
// rendered ONLY where there is no official median, so a page never carries two
// competing "median house price" figures.
//
// What it must never become: `latest_median_price`. That field drives the state
// ranks, the choropleth and the comparison bars, and this measure cannot support
// any of them —
//   - it comes from CURRENT portal listings, not settled transfers;
//   - the crawl catalog reaches 500 suburbs nationally, so there is no
//     population to rank against;
//   - a sold-listing median is not the same measure as a Valuer-General median
//     and is not comparable with the NSW/VIC/SA figures on other pages.
// Every one of those limits is stated on the card rather than left implied.
//
// LICENCE: derived aggregates only. The underlying REA/Domain rows carry
// source_licence='proprietary-tos-restricted' and are never republished — counts
// and medians are the publishable surface. The API strips this block entirely
// when HOUSING_DROP_LISTINGS_ENABLED is off.
import type { SuburbListingStats } from "~/gen/shorts/v1alpha1/housing_pb";

export function SuburbListingEstimate({
  stats,
  suburbName,
  fmt,
}: {
  stats: SuburbListingStats | undefined;
  suburbName: string;
  fmt: (v: number) => string;
}) {
  if (!stats) return null;
  const hasSold = stats.soldCount > 0 && stats.medianSold > 0;
  const hasAsking = stats.forSaleCount > 0 && stats.medianAsking > 0;
  if (!hasSold && !hasAsking) return null;

  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        From current listings
      </div>

      <div className="mt-2.5 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        {hasSold ? (
          <span>
            <span className="font-mono text-xl font-semibold tabular-nums text-foreground">
              {fmt(stats.medianSold)}
            </span>
            <span className="ml-2 text-[11px] text-muted-foreground">
              median sold · {stats.soldCount.toLocaleString()}{" "}
              {stats.soldCount === 1 ? "sale" : "sales"}
            </span>
          </span>
        ) : null}
        {hasAsking ? (
          <span>
            <span className="font-mono text-base font-semibold tabular-nums text-foreground">
              {fmt(stats.medianAsking)}
            </span>
            <span className="ml-2 text-[11px] text-muted-foreground">
              median asking · {stats.forSaleCount.toLocaleString()} listed
            </span>
          </span>
        ) : null}
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground [text-wrap:pretty]">
        Aggregated from residential listings we track in {suburbName}, not from
        Valuer-General settled transfers. It is a different measure on a much smaller
        sample, so it is <strong>not comparable</strong> with the median house prices
        shown for NSW, Victoria and South Australia suburbs, and {suburbName} is not
        ranked on it.
      </p>
    </div>
  );
}
