"use client";

import { useQuery } from "@tanstack/react-query";
import type { Topology } from "topojson-specification";

/** Lazy-fetch + cache a committed TopoJSON asset from /public/geo. */
export function useTopojson(url: string | null) {
  return useQuery({
    queryKey: ["topojson", url],
    enabled: !!url,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async (): Promise<Topology> => {
      const res = await fetch(url!);
      if (!res.ok) throw new Error(`topojson ${url}: ${res.status}`);
      return res.json();
    },
  });
}
