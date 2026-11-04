import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

/**
 * The Changes page's skeleton: the heading, the tab row and the first rows of the
 * comparison table, in the shape the page draws.
 */
export default function ChangesLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 sm:px-8">
          <div className="h-4 w-40 rounded-sm bg-muted/40" />
          <div className="space-y-3">
            <div className="h-9 w-72 max-w-full rounded-sm bg-muted/40" />
            <div className="h-5 w-[28rem] max-w-full rounded-sm bg-muted/40" />
          </div>
          <div className="flex gap-3">
            <div className="h-9 w-40 rounded-md bg-muted/40" />
            <div className="h-9 w-48 rounded-md bg-muted/40" />
          </div>
          <div className="space-y-px">
            {Array.from({ length: 10 }, (_, index) => (
              <div key={index} className="h-11 rounded-sm bg-muted/40" />
            ))}
          </div>
        </div>
      </DashboardLayout>
    </div>
  );
}
