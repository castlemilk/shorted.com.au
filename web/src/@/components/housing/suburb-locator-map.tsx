// Server component: where the suburb sits in its state. The state outline and
// the suburb polygon are projected on the server (lib/housing/suburb-geometry)
// and rendered as inline SVG — no per-state TopoJSON fetch, no client bundle.
//
// A suburb is a handful of pixels at state scale, so the polygon is drawn AND a
// ringed marker sits on its centroid; the ring is what a reader actually sees.
import Link from "next/link";

import type { StateLocatorModel } from "@/lib/housing/suburb-geometry";
import { STATE_NAMES, stateSlug } from "@/lib/housing/states";

export function SuburbLocatorMap({
  stateCode, salCode, salName, model,
}: {
  stateCode: string; salCode: string; salName: string; model: StateLocatorModel | null | undefined;
}) {
  const stateName = STATE_NAMES[stateCode] ?? stateCode;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-2 font-serif text-base text-foreground">
        Where it is in {stateName}
      </h3>
      {model ? (
        <svg
          viewBox={`0 0 ${model.width} ${model.height}`}
          className="h-[200px] w-full"
          role="img"
          aria-label={`Location of ${salName} within ${stateName}`}
        >
          <path
            d={model.statePath}
            fill="currentColor"
            fillOpacity={0.08}
            stroke="currentColor"
            strokeOpacity={0.45}
            strokeWidth={1}
            className="text-muted-foreground"
            vectorEffect="non-scaling-stroke"
          />
          {model.suburbPath ? (
            <path d={model.suburbPath} className="fill-primary" stroke="none" />
          ) : null}
          <circle
            cx={model.marker.x}
            cy={model.marker.y}
            r={7}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            className="text-primary"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={model.marker.x} cy={model.marker.y} r={2.5} className="fill-primary" />
        </svg>
      ) : (
        <p className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">
          Boundary not available for this suburb.
        </p>
      )}
      <Link
        href={`/housing/${stateSlug(stateCode)}?sal=${salCode}`}
        className="mt-2 inline-block text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        View on the full {stateName} map →
      </Link>
    </div>
  );
}
