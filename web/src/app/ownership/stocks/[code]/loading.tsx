import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

/**
 * The register skeleton, sized to the page's first screens: the breadcrumb row,
 * the header and its nameplate, the readout, the first twelve lanes (the rest
 * wait behind a disclosure), then the fund table. It draws inside the same
 * DashboardLayout the page uses, so the sidebar stays put when a client
 * navigation lands here, and each placeholder sits where its content will.
 */
export default function RegisterLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          <div className="h-4 w-56 animate-pulse rounded-sm bg-muted/40" />
          <div className="space-y-3">
            <div className="h-24 animate-pulse rounded-lg bg-muted/40" />
            <div className="h-9 animate-pulse rounded-md bg-muted/40" />
          </div>
          <div className="space-y-3">
            <div className="h-8 w-40 animate-pulse rounded-sm bg-muted/40" />
            <div className="h-[140px] animate-pulse rounded-lg bg-muted/40" />
          </div>
          <div className="space-y-3">
            <div className="h-8 w-48 animate-pulse rounded-sm bg-muted/40" />
            <div className="space-y-px">
              {Array.from({ length: 12 }, (_, index) => (
                <div key={index} className="h-11 animate-pulse rounded-sm bg-muted/40" />
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <div className="h-8 w-44 animate-pulse rounded-sm bg-muted/40" />
            <div className="h-[300px] animate-pulse rounded-lg bg-muted/40" />
          </div>
        </div>
      </DashboardLayout>
    </div>
  );
}
