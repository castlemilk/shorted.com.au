"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ChoroplethMap } from "./choropleth-map";
import { useTopojson } from "./use-topojson";
import { STATE_NAMES, stateSlug } from "@/lib/housing/states";

/** Static inset showing where a suburb sits within its state. */
export function SuburbLocatorMap({
  stateCode, salCode, salName,
}: {
  stateCode: string; salCode: string; salName: string;
}) {
  const { data: topo } = useTopojson(`/geo/suburbs/${stateCode}.topojson`);
  const valueById = useMemo(() => new Map<string, number | null>([[salCode, 1]]), [salCode]);
  const nameById = useMemo(() => new Map<string, string>([[salCode, salName]]), [salCode, salName]);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-2 font-serif text-base text-foreground">
        Where it is in {STATE_NAMES[stateCode] ?? stateCode}
      </h3>
      {!topo ? (
        <div className="h-[200px] w-full animate-pulse rounded-lg bg-muted" />
      ) : (
        <ChoroplethMap
          topology={topo}
          objectName={Object.keys(topo.objects)[0]!}
          valueById={valueById}
          nameById={nameById}
          colorScale={() => "hsl(24 92% 50%)"}
          selectedId={salCode}
          interactive={false}
          height={200}
          ariaLabel={`Location of ${salName} within ${STATE_NAMES[stateCode] ?? stateCode}`}
        />
      )}
      <Link
        href={`/housing/${stateSlug(stateCode)}?sal=${salCode}`}
        className="mt-2 inline-block text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        View on the full {STATE_NAMES[stateCode] ?? stateCode} map →
      </Link>
    </div>
  );
}
