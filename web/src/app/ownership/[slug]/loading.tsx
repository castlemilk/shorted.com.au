import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

/**
 * The institution's skeleton, sized to the page's first screens: the breadcrumb
 * row, the name and lede, the four summary tiles, then the first rows of its
 * holdings. A segment's loading.tsx wraps every route under it that has none of
 * its own, so this file stands between a client navigation to an institution and
 * the hub's desk skeleton, which has another shape. It draws inside the same
 * DashboardLayout the page uses, so the sidebar stays put, and each placeholder
 * sits where its content will. The blocks are static: a looping pulse is motion
 * the page does not need.
 */
export default function InstitutionLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          <div className="h-4 w-56 rounded-sm bg-muted/40" />
          <div className="space-y-3">
            <div className="h-9 w-80 max-w-full rounded-sm bg-muted/40" />
            <div className="h-12 w-full max-w-[70ch] rounded-sm bg-muted/40" />
          </div>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="h-24 bg-card p-4">
                <div className="h-3 w-24 rounded-sm bg-muted/40" />
                <div className="mt-3 h-7 w-16 rounded-sm bg-muted/40" />
              </div>
            ))}
          </div>
          <div className="space-y-3">
            <div className="h-7 w-64 max-w-full rounded-md bg-muted/40" />
            <div className="space-y-px">
              {Array.from({ length: 10 }, (_, index) => (
                <div key={index} className="h-11 rounded-sm bg-muted/40" />
              ))}
            </div>
          </div>
        </div>
      </DashboardLayout>
    </div>
  );
}
