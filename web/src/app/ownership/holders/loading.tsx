import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

/**
 * The holders skeleton, sized to the workspace's first screen: the heading and
 * lede, the directory's find box and chips with its first rows, the map's frame
 * and the inspector's rail. It draws inside the same DashboardLayout and
 * WorkspacePage the page uses, so each block sits where its content will. The
 * blocks are static: a looping pulse is motion the page does not need.
 */
export default function HoldersLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[1400px] lg:grid lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-8 px-4 py-6 sm:px-8">
            <div className="space-y-3">
              <div className="h-9 w-80 max-w-full rounded-sm bg-muted/40" />
              <div className="h-5 w-full max-w-[60ch] rounded-sm bg-muted/40" />
            </div>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
              <div className="space-y-4">
                <div className="h-10 rounded-md bg-muted/40" />
                <div className="h-8 rounded-md bg-muted/40" />
                <div className="space-y-px">
                  {Array.from({ length: 8 }, (_, index) => (
                    <div key={index} className="h-14 rounded-sm bg-muted/40" />
                  ))}
                </div>
              </div>
              <div className="h-96 rounded-sm bg-muted/40" />
            </div>
          </div>
          <div className="hidden min-w-0 px-4 py-6 sm:px-8 lg:block lg:border-l lg:border-border lg:pl-6 lg:pr-8">
            <div className="space-y-3">
              <div className="h-4 w-32 rounded-sm bg-muted/40" />
              <div className="h-8 w-56 max-w-full rounded-sm bg-muted/40" />
              <div className="h-24 rounded-sm bg-muted/40" />
            </div>
          </div>
        </div>
      </DashboardLayout>
    </div>
  );
}
