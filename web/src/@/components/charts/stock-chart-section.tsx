/**
 * The pieces of a stock page's chart section that a server component renders
 * (spec D4): the heading, the box's height, and the skeleton that holds the
 * panel's place until it has loaded.
 *
 * No "use client" and no Connect imports, on purpose. The panel itself is a
 * client-only island (Connect-RPC and the market-data hooks), so a page can
 * only reach it through `next/dynamic` with `ssr: false`; everything the page
 * needs on the server lives here instead, where importing it costs the route
 * nothing and cannot drag Connect into a server bundle.
 */
import { cn } from "@/lib/utils";

/**
 * The height of the chart's box: 360px on a phone, 420px from `sm`. The panel
 * and its skeleton both size the box with this one constant, so a hydrated
 * panel lands on the footprint the skeleton held and nothing below it moves.
 */
export const CHART_BOX_HEIGHT_CLASS = "h-[360px] sm:h-[420px]";

/**
 * The heading row above the chart: the title, and a hint from `xl` up, where
 * the panel's controls are on one row too (spec D4).
 *
 * The hint needs about 610px beside the title (228px, a 24px gap, 360px). From
 * `sm` the content has less than that between 640px and about 740px (576px at
 * 640px, 512px with the signed-in sidebar), so the heading wrapped onto a
 * second line there, 20px taller than the one `h-7` line the routes'
 * `loading.tsx` holds for it. From `xl` the content is at least 960px (1280px
 * less the signed-in sidebar and the container's padding), so the row is one
 * 28px line at every width.
 */
export function StockChartHeading({
  title = "Price & short interest",
  id = "stock-chart-heading",
}: {
  title?: string;
  id?: string;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <span className="hidden text-xs text-muted-foreground xl:inline">
        Toggle series, zoom, and compare · ASIC daily, T+4
      </span>
    </div>
  );
}

const BONE = "animate-pulse rounded-md bg-muted/40";

/**
 * The panel before it has loaded, row for row: the controls, then the box. Below
 * `xl` the panel also has its period control and its toggles under the chart,
 * and those rows are here too. The heading is not part of this; the page renders
 * `StockChartHeading` itself, so the title is real text in the server HTML.
 *
 * Every row has the height and the gap the panel gives it (StockChartPanel's
 * grid: `gap-3`, rows of 40, the box, 40 and 36 below `xl`, one 32px row and the
 * box from `xl`; the box is 360px, 420px from `sm`). Change one side and change
 * the other.
 *
 * Hidden from assistive technology: it is a placeholder, and the route's
 * `loading.tsx` owns the `role="status"` that says something is loading.
 */
export function StockChartPanelSkeleton() {
  return (
    <div aria-hidden="true">
      <div className={cn(BONE, "h-10 xl:h-8")} />
      <div className={cn(BONE, "mt-3 rounded-lg", CHART_BOX_HEIGHT_CLASS)} />
      <div className={cn(BONE, "mt-3 h-10 xl:hidden")} />
      <div className={cn(BONE, "mt-3 h-9 xl:hidden")} />
    </div>
  );
}
