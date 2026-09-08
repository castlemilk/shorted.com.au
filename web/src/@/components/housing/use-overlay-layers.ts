"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Topology } from "topojson-specification";
import { OVERLAY_BY_KEY, overlayAssetUrl, overlayAvailable, type OverlayKey } from "@/lib/housing/overlays";
import type { OverlayLayer } from "./choropleth-map";

/** Fetches the committed overlay TopoJSON for each active, available key. */
export function useOverlayLayers(
  stateCode: string,
  keys: readonly OverlayKey[],
  opacities: Partial<Record<OverlayKey, number>> = {},
): {
  layers: OverlayLayer[];
  isLoading: boolean;
  /** Keys still downloading — the picker shows a spinner per row. */
  loadingKeys: OverlayKey[];
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
  const loadingKeys = wanted.filter((_, i) => results[i]?.isLoading);
  // A fixed-length dependency list: which layers, their opacity, and WHEN each
  // last loaded (a spread of the data objects varies in length as layers are
  // toggled, which React rejects).
  const identity = wanted.map((k, i) => `${k}:${opacities[k] ?? ""}:${results[i]?.dataUpdatedAt ?? 0}`).join("|");
  const layers = useMemo(
    () => wanted.flatMap((key, i) => {
      const topo = loaded[i];
      return topo ? [{ key, topology: topo, color: OVERLAY_BY_KEY[key].color, opacity: opacities[key] }] : [];
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity encodes wanted, opacity and load time
    [identity],
  );
  return { layers, isLoading, loadingKeys };
}
