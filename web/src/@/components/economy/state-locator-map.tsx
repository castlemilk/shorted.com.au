"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ChoroplethMap } from "@/components/housing/choropleth-map";
import { useTopojson } from "@/components/housing/use-topojson";
import {
  STATE_NAMES,
  STATE_SLUGS,
  toTopoFeatureId,
  type StateSlug,
} from "@/lib/economy/map-metrics";

// Same object name + numeric ABS STE_CODE21 ids the explorer uses.
const TOPO_OBJECT = "STE_2021_AUST_GDA2020";

/**
 * A small static locator inset for a state page: the national choropleth with
 * ONLY the current state filled, framed to that state (fitToId) and with all
 * interaction disabled (interactive={false}) — the housing suburb-locator
 * pattern. The whole thing links back to the /economy hub.
 */
export function StateLocatorMap({ state }: { state: StateSlug }) {
  const { data: topo } = useTopojson("/geo/states.topojson");
  const name = STATE_NAMES[state];
  const topoId = toTopoFeatureId(state);

  // Fill just this state (value 1); every other state is "no data" (hatched
  // muted), so the eye lands on the highlighted region.
  const valueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const s of STATE_SLUGS) {
      m.set(toTopoFeatureId(s), s === state ? 1 : null);
    }
    return m;
  }, [state]);

  const nameById = useMemo(
    () => new Map(STATE_SLUGS.map((s) => [toTopoFeatureId(s), STATE_NAMES[s]])),
    [],
  );

  // Single-colour scale — the selected state renders in the brand primary.
  const colorScale = () => "hsl(var(--primary))";

  return (
    <Link
      href="/economy"
      aria-label={`${name} on the Australian map — back to the economy hub`}
      className="group relative block h-40 overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-primary/50"
    >
      {topo ? (
        <ChoroplethMap
          fill
          topology={topo}
          objectName={TOPO_OBJECT}
          valueById={valueById}
          colorScale={colorScale}
          nameById={nameById}
          fitToId={topoId}
          interactive={false}
          ariaLabel={`Locator map highlighting ${name}`}
        />
      ) : (
        <div className="h-full w-full animate-pulse bg-muted" />
      )}
      <span className="pointer-events-none absolute bottom-1.5 left-2 rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground backdrop-blur transition-colors group-hover:text-foreground">
        ← Back to map
      </span>
    </Link>
  );
}
