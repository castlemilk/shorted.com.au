// Server component. The drill trail for /housing → /housing/[state] →
// /housing/[state]/[suburb], pinned under the site header so you never lose the
// "where am I, how do I get back" affordance while scrolling a long profile.
//
// top-16 is load-bearing: SiteHeader is `sticky top-0 z-50` with an h-16 row, so
// anything lower would slide under it. z-30 keeps this below the header and below
// dialogs. Sticky only works because DashboardLayout's <main> no longer declares
// `overflow-y-auto` — an overflow ancestor would become the scrollport this binds
// to, and that element never scrolls, so the bar would simply scroll away.
//
// The neighbour links are NOT a sequence. They come from the same list as the
// sidebar's nearby card, which is same-postcode suburbs when the state publishes
// postcodes and otherwise the closest by median price — so they carry no
// chevrons and the label says which basis is in play.
import Link from "next/link";

import { HousingBreadcrumb } from "./housing-breadcrumb";
import { STATE_NAMES, stateSlug, suburbHref, titleCaseName } from "@/lib/housing/states";
import type { SuburbContext } from "@/lib/housing/suburb-stats";

export type ContextNeighbour = {
  salCode: string;
  salName: string;
  postcode: string;
};

export function SuburbContextBar({
  stateCode,
  suburbName,
  salCode,
  neighbours = [],
  basis = "none",
}: {
  stateCode: string;
  suburbName: string;
  /** Preselects this suburb on the state explorer — the link's accessible name
   * promises "view THIS suburb on the map", and the explorer reads `?sal=`. */
  salCode: string;
  neighbours?: readonly ContextNeighbour[];
  basis?: SuburbContext["nearbyBasis"];
}) {
  const stateName = STATE_NAMES[stateCode] ?? stateCode;
  const shown = neighbours.slice(0, 2);
  const basisLabel = basis === "postcode" ? "Same postcode" : "Similar price";
  return (
    <div className="sticky top-16 z-30 -mx-4 flex items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      {/* Only the trail scrolls. The action stays pinned — with it inside the
          scroller, `ml-auto` had no free space to distribute on a phone and the
          link ended up off-screen behind a horizontal swipe. */}
      <div className="flex h-11 min-w-0 flex-1 items-center gap-3 overflow-x-auto">
        <HousingBreadcrumb stateCode={stateCode} suburb={suburbName} compact />

        {shown.length ? (
          <>
            <span aria-hidden className="hidden h-4 w-px shrink-0 bg-border sm:block" />
            <nav
              aria-label={`${basisLabel} suburbs`}
              className="hidden shrink-0 items-center gap-1 text-[11px] sm:flex"
            >
              <span className="whitespace-nowrap text-muted-foreground">{basisLabel}:</span>
              {shown.map((n, i) => (
                <span key={n.salCode} className="inline-flex items-center">
                  {i > 0 ? <span aria-hidden className="text-muted-foreground/60">·</span> : null}
                <Link
                  href={suburbHref(stateCode, n)}
                  className="hit-target-touch inline-flex items-center whitespace-nowrap rounded px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {titleCaseName(n.salName)}
                </Link>
                </span>
              ))}
            </nav>
          </>
        ) : null}
      </div>

      <Link
        href={`/housing/${stateSlug(stateCode)}?sal=${salCode}`}
        aria-label={`View ${suburbName.toLowerCase()} on the ${stateName} map`}
        className="hit-target-touch inline-flex shrink-0 items-center whitespace-nowrap text-[11px] text-primary transition-colors hover:text-foreground"
      >
        <span className="hidden sm:inline">View on the {stateName} map</span>
        {/* The short label is what leaves room for the suburb segment of the
            breadcrumb at 390px; the accessible name stays full either way. */}
        <span className="sm:hidden">Map</span>
        <span aria-hidden> →</span>
      </Link>
    </div>
  );
}
