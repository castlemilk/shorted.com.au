import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

/**
 * The market-moves skeleton, sized to the page's first screen: the breadcrumb
 * row, the header and its note, one date heading, then the first moves. It
 * draws inside the same DashboardLayout the page uses, so the sidebar stays put
 * when a client navigation lands here. The blocks are static.
 */
export default function MarketMovesLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading market moves">
      <DashboardLayout>
        <div className="mx-auto w-full max-w-4xl space-y-8">
          <div className="h-4 w-48 rounded-sm bg-muted/40" />
          <div className="space-y-3 border-b border-border/40 pb-6">
            <div className="h-14 w-72 max-w-full rounded-sm bg-muted/40" />
            <div className="h-10 w-full max-w-[70ch] rounded-sm bg-muted/40" />
          </div>
          <div className="space-y-3">
            <div className="h-4 w-56 rounded-sm bg-muted/40" />
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="h-40 rounded-xl bg-muted/40" />
            ))}
          </div>
        </div>
      </DashboardLayout>
    </div>
  );
}
