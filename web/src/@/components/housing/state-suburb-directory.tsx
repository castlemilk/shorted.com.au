// Server component: the crawlable suburb directory on /housing/[state].
//
// The interactive explorer above it is a client island (a map cannot be
// server rendered), so before this the state page's HTML linked to zero
// suburbs and Search Console reported suburb pages as discovered only via the
// sitemap. Each list is a handful of real, ranked links plus the state's
// rankings pages, which themselves list up to a hundred suburbs each.
import Link from "next/link";

import type { StateSuburbDirectory } from "@/lib/housing/state-suburb-directory";
import { STATE_NAMES, suburbHref, titleCaseName } from "@/lib/housing/states";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import type { SuburbLike } from "@/lib/housing/suburb-stats";
import { HOUSING_RANKINGS } from "@/lib/housing-rankings/registry";

function SuburbList({
  heading, stateCode, suburbs, value, moreHref, moreLabel,
}: {
  heading: string;
  stateCode: string;
  suburbs: readonly SuburbLike[];
  value: (s: SuburbLike) => string;
  moreHref?: string;
  moreLabel?: string;
}) {
  if (!suburbs.length) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="font-serif text-base text-foreground">{heading}</h3>
      <ol className="mt-2 flex flex-col">
        {suburbs.map((s) => (
          <li key={s.salCode}>
            <Link
              href={suburbHref(stateCode, s)}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <span className="truncate">{titleCaseName(s.salName)}</span>
              <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums text-foreground">
                {value(s)}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      {moreHref ? (
        <Link href={moreHref} className="mt-2 inline-block text-xs text-primary underline-offset-4 hover:underline">
          {moreLabel} →
        </Link>
      ) : null}
    </div>
  );
}

export function StateSuburbDirectorySection({
  stateCode, directory,
}: {
  stateCode: string;
  directory: StateSuburbDirectory;
}) {
  const stateName = STATE_NAMES[stateCode] ?? stateCode;
  const st = stateCode.toLowerCase();
  const rankings = Object.values(HOUSING_RANKINGS).filter((r) => r.stateCode === stateCode);
  // Ranking pages exist only for states with a Valuer-General feed; a "see all"
  // link into a 404 would be worse than no link, so each is gated on the registry.
  const rankingHref = (prefix: string) => {
    const slug = `${prefix}-${st}`;
    return slug in HOUSING_RANKINGS ? `/housing/rankings/${slug}` : undefined;
  };
  const priced = directory.pricedCount > 0;
  const fmtGrowth = (s: SuburbLike) => `${s.yoyPct > 0 ? "+" : ""}${s.yoyPct.toFixed(1)}%`;
  const fmtPop = (s: SuburbLike) => (s.population ?? 0).toLocaleString("en-AU");

  return (
    <section aria-labelledby="state-suburb-directory-heading" className="space-y-4">
      <div>
        <h2 id="state-suburb-directory-heading" className="font-serif text-2xl text-foreground">
          {stateName} suburbs at a glance
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {priced
            ? `${directory.pricedCount.toLocaleString("en-AU")} of ${directory.total.toLocaleString("en-AU")} ${stateName} suburbs carry a Valuer-General median house price` +
              (directory.averageOfMedians ? `; the average of those suburb medians is ${fmtPriceShort(directory.averageOfMedians)}.` : ".")
            : `${directory.total.toLocaleString("en-AU")} ${stateName} suburbs with ABS Census demographics, amenities and electorates. No Valuer-General price feed is published for ${stateName}, so these profiles carry no median house price.`}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SuburbList
          heading="Most expensive"
          stateCode={stateCode}
          suburbs={directory.mostExpensive}
          value={(s) => fmtPriceShort(s.latestMedianPrice)}
          moreHref={rankingHref("most-expensive-suburbs")}
          moreLabel={`All most expensive ${stateCode} suburbs`}
        />
        <SuburbList
          heading="Most affordable"
          stateCode={stateCode}
          suburbs={directory.mostAffordable}
          value={(s) => fmtPriceShort(s.latestMedianPrice)}
          moreHref={rankingHref("cheapest-suburbs")}
          moreLabel={`All cheapest ${stateCode} suburbs`}
        />
        <SuburbList
          heading="Fastest growing, past year"
          stateCode={stateCode}
          suburbs={directory.fastestGrowing}
          value={fmtGrowth}
          moreHref={rankingHref("fastest-growing-suburbs")}
          moreLabel={`All fastest growing ${stateCode} suburbs`}
        />
        <SuburbList
          heading="Largest by population"
          stateCode={stateCode}
          suburbs={directory.largest}
          value={fmtPop}
        />
      </div>
      {rankings.length ? (
        <p className="text-sm text-muted-foreground">
          Rankings:{" "}
          {rankings.map((r, i) => (
            <span key={r.slug}>
              {i > 0 ? " · " : null}
              <Link href={`/housing/rankings/${r.slug}`} className="text-primary underline-offset-4 hover:underline">
                {r.h1}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}
