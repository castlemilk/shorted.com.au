import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

/**
 * The fund page's skeleton, in the shape the page draws: the breadcrumb row, the
 * ticker and title, the stat strip and the first rows of the portfolio map. A
 * segment's loading.tsx wraps every fund route, so this stands before the page.
 */
export default function FundLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 sm:px-8">
          <div className="h-4 w-56 rounded-sm bg-muted/40" />
          <div className="space-y-3">
            <div className="h-6 w-20 rounded-sm bg-muted/40" />
            <div className="h-9 w-[28rem] max-w-full rounded-sm bg-muted/40" />
            <div className="h-5 w-96 max-w-full rounded-sm bg-muted/40" />
          </div>
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="h-16 bg-card" />
            ))}
          </div>
          <div className="h-[24rem] w-full rounded-md bg-muted/40" />
        </div>
      </DashboardLayout>
    </div>
  );
}
