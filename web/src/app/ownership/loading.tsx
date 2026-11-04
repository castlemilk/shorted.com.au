import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

/**
 * The desk's skeleton, sized to the hub it stands in for (backlog B2): the title and lede, the plate,
 * one toolbar row, the headline band of four sentences, the two rows of panes (the map and the
 * disclosed exposure at a fixed 420px from lg; the notice activity and the index fund positions at
 * 320px), and the records line. It draws inside the same DashboardLayout the hub uses, so the sidebar
 * stays put on a client navigation, and each placeholder sits where its instrument will. The blocks
 * are static: a looping pulse is motion the desk does not need.
 */
export default function OwnershipLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[100rem] space-y-8">
          <div className="space-y-3">
            <div className="h-9 w-72 rounded-sm bg-muted/40" />
            <div className="h-7 w-full max-w-[60ch] rounded-sm bg-muted/40" />
          </div>
          <div className="h-5 w-full max-w-[60rem] rounded-md bg-muted/40" />

          <div className="h-11 w-full rounded-md bg-muted/40" aria-hidden="true" />

          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
            {[0, 1, 2, 3].map((cell) => (
              <div key={cell} className="h-16 bg-card p-3">
                <div className="h-4 w-4/5 rounded-sm bg-muted/40" />
              </div>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2" aria-hidden="true">
            <div className="min-w-0 space-y-3 lg:h-[420px]">
              <div className="h-7 w-64 max-w-full rounded-md bg-muted/40" />
              <div className="aspect-[360/330] w-full rounded-md bg-muted/40 lg:aspect-auto lg:h-[calc(100%-2.5rem)]" />
            </div>
            <div className="min-w-0 space-y-3 lg:h-[420px]">
              <div className="h-7 w-64 max-w-full rounded-md bg-muted/40" />
              <div className="aspect-[360/330] w-full rounded-md bg-muted/40 sm:aspect-[600/400] lg:aspect-auto lg:h-[calc(100%-2.5rem)]" />
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2" aria-hidden="true">
            <div className="min-w-0 space-y-3 lg:h-[320px]">
              <div className="h-7 w-64 max-w-full rounded-md bg-muted/40" />
              <div className="space-y-px">
                {Array.from({ length: 12 }, (_, index) => (
                  <div key={index} className="h-[18px] rounded-sm bg-muted/40" />
                ))}
              </div>
            </div>
            <div className="min-w-0 space-y-3 lg:h-[320px]">
              <div className="h-7 w-64 max-w-full rounded-md bg-muted/40" />
              <div className="h-[13.5rem] w-full rounded-md bg-muted/40" />
            </div>
          </div>

          <div className="h-5 w-full max-w-[40rem] rounded-sm bg-muted/40" aria-hidden="true" />
        </div>
      </DashboardLayout>
    </div>
  );
}
