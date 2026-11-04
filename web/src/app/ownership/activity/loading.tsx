import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

/**
 * The instrument's skeleton: the title and lede, the control row and the drawing
 * it stands in for, under the same workspace grid the page draws. Static blocks;
 * the loading state is a status region the reader can find.
 */
export default function InstrumentLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[100rem] space-y-6 px-4 py-6 sm:px-8" aria-hidden="true">
          <div className="space-y-3">
            <div className="h-9 w-72 max-w-full rounded-sm bg-muted/40" />
            <div className="h-6 w-96 max-w-full rounded-sm bg-muted/40" />
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="h-8 w-64 max-w-full rounded-md bg-muted/40" />
            <div className="h-8 w-56 max-w-full rounded-md bg-muted/40" />
          </div>
          <div className="aspect-[1000/560] w-full rounded-md bg-muted/40" />
        </div>
      </DashboardLayout>
    </div>
  );
}
