"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Topology } from "topojson-specification";
import { OVERLAY_BY_KEY, overlayAssetUrl, overlayAvailable, type OverlayKey } from "@/lib/housing/overlays";
import type { OverlayLayer } from "./choropleth-map";

/** Fetches the committed overlay TopoJSON for each active, available key. */
export function useOverlayLayers(stateCode: string, keys: readonly OverlayKey[]): {
  layers: OverlayLayer[];
  isLoading: boolean;
} {
  const wanted = keys.filter((k) => overlayAvailable(k, stateCode));
  const results = useQueries({
    queries: wanted.map((key) => ({
      queryKey: ["topojson", overlayAssetUrl(stateCode, key)],
      staleTime: Infinity,
      gcTime: Infinity,
      queryFn: async (): Promise<Topology> => {
        const res = await fetch(overlayAssetUrl(stateCode, key));
        if (!res.ok) throw new Error(`overlay ${key}: ${res.status}`);
        return (await res.json()) as Topology;
      },
    })),
  });
  const loaded = results.map((r) => r.data);
  const isLoading = results.some((r) => r.isLoading);
  const layers = useMemo(
    () => wanted.flatMap((key, i) => {
      const topo = loaded[i];
      return topo ? [{ key, topology: topo, color: OVERLAY_BY_KEY[key].color }] : [];
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loaded is derived per render; wanted+data identity is what matters
    [wanted.join(","), ...loaded],
  );
  return { layers, isLoading };
}
