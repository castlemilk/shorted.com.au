import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

/**
 * The notices skeleton, sized to the page's first screens: the breadcrumb row,
 * the header and its nameplate, the filter controls, the week bars, then the
 * first rows of the feed. It draws inside the same DashboardLayout the page uses,
 * so the sidebar stays put when a client navigation lands here, and each
 * placeholder sits where its content will. The blocks are static: a looping pulse
 * is motion the page does not need.
 */
export default function NoticesLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          <div className="h-4 w-56 rounded-sm bg-muted/40" />
          <div className="space-y-3">
            <div className="h-9 w-80 rounded-sm bg-muted/40" />
            <div className="h-12 w-full max-w-[70ch] rounded-sm bg-muted/40" />
          </div>
          <div className="h-7 w-72 max-w-full rounded-md bg-muted/40" />
          <div className="space-y-3">
            <div className="h-11 rounded-md bg-muted/40 sm:h-8" />
            <div className="h-16 rounded-md bg-muted/40" />
            <div className="space-y-px">
              {Array.from({ length: 12 }, (_, index) => (
                <div key={index} className="h-11 rounded-sm bg-muted/40" />
              ))}
            </div>
          </div>
        </div>
      </DashboardLayout>
    </div>
  );
}
