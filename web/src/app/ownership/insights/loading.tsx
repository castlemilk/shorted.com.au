import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

/**
 * The insights skeleton, sized to the page's first screens: the breadcrumb row,
 * the header and its nameplate, the desk, the window controls, then the market
 * map. It draws inside the same DashboardLayout the page uses, so the sidebar
 * stays put on a client navigation. The blocks are static: no looping pulse.
 */
export default function InsightsLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          <div className="h-4 w-56 rounded-sm bg-muted/40" />
          <div className="space-y-3">
            <div className="h-9 w-72 rounded-sm bg-muted/40" />
            <div className="h-12 w-full max-w-[70ch] rounded-sm bg-muted/40" />
          </div>
          <div className="h-7 w-72 max-w-full rounded-md bg-muted/40" />
          <div className="h-56 rounded-lg bg-muted/40" />
          <div className="h-36 rounded-lg bg-muted/40" />
          <div className="h-[420px] rounded-lg bg-muted/40" />
        </div>
      </DashboardLayout>
    </div>
  );
}
