// Server component: a static locator thumbnail — the suburb filled with the
// theme accent, in-view neighbours as faint context. The paths arrive already
// projected (lib/housing/suburb-geometry, run once on the server), so this
// ships a few hundred bytes of SVG and no client JavaScript.
//
// It used to be a "use client" island that fetched the whole state's boundary
// TopoJSON (336 KB gzipped for NSW) to draw this 200px inset on every visit.
import type { SuburbLocatorModel } from "@/lib/housing/suburb-geometry";

export function SuburbBannerMap({ model }: { model: SuburbLocatorModel | null | undefined }) {
  if (!model) return null;
  return (
    <svg viewBox={`0 0 ${model.size} ${model.size}`} className="h-full w-full" role="img" aria-label="Suburb location">
      {model.neighbourPaths.map((n) => (
        <path
          key={n.id}
          d={n.d}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={1}
          className="text-muted-foreground"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <path
        d={model.targetPath}
        stroke="currentColor"
        strokeOpacity={0.7}
        strokeWidth={1.5}
        className="fill-primary text-primary"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
