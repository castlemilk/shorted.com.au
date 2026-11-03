import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { MAP_HEIGHT, MAP_WIDTH } from "~/@/components/ownership/desk/ownership-map-static";

/**
 * The desk's skeleton, sized to the instruments it stands in for: the title and
 * lede, the plate, the map at its 1000 by 560 drawing with the window and lens
 * chips above it, the flows and the movement side by side from `lg` (the flows
 * drawing is 600 by 400 from `sm`, 360 by 330 below; the movement is 18 px a
 * sector row, 22 px for its brush), then the index fund window. It draws inside
 * the same DashboardLayout the hub uses, so the sidebar stays put on a client
 * navigation, and each placeholder sits where its instrument will. The blocks are
 * static: a looping pulse is motion the desk does not need.
 */
export default function OwnershipLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          <div className="space-y-3">
            <div className="h-9 w-72 rounded-sm bg-muted/40" />
            <div className="h-12 w-full max-w-[70ch] rounded-sm bg-muted/40" />
          </div>
          <div className="h-7 w-full max-w-[60rem] rounded-md bg-muted/40" />

          <section className="space-y-4" aria-hidden="true">
            <div className="flex flex-wrap gap-2">
              <div className="h-7 w-72 max-w-full rounded-md bg-muted/40" />
              <div className="h-7 w-80 max-w-full rounded-md bg-muted/40" />
            </div>
            <div className="w-full rounded-md bg-muted/40" style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}` }} />
          </section>

          <div className="grid gap-10 lg:grid-cols-2" aria-hidden="true">
            <section className="space-y-4">
              <div className="h-7 w-64 max-w-full rounded-md bg-muted/40" />
              <div className="aspect-[360/330] w-full rounded-md bg-muted/40 sm:aspect-[600/400]" />
            </section>
            <section className="space-y-4">
              <div className="h-7 w-64 max-w-full rounded-md bg-muted/40" />
              <div className="h-[13.5rem] w-full rounded-md bg-muted/40 sm:h-[16.5rem]" />
            </section>
          </div>

          <section className="grid gap-6 lg:grid-cols-2" aria-hidden="true">
            {[0, 1].map((column) => (
              <div key={column} className="space-y-px">
                {Array.from({ length: 10 }, (_, index) => (
                  <div key={index} className="h-6 rounded-sm bg-muted/40" />
                ))}
              </div>
            ))}
          </section>
        </div>
      </DashboardLayout>
    </div>
  );
}
