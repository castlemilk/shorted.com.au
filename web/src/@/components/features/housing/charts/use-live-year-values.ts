"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getHousePriceSeriesClient } from "~/app/actions/client/getHousingClient";
import type { YearValue } from "../data/types";

/**
 * Splices a live national house-price series onto a baked editorial array.
 *
 * The baked array supplies the long, fact-checked historical spine; live annual
 * values (the quarterly series collapsed to an annual mean) override and extend
 * the recent years. If live data is unavailable (loading, empty, RPC error), it
 * falls back entirely to the baked array — preserving the feature's citable
 * series and keeping the chart resilient (it is rendered ssr:false).
 *
 * investor_loan_share is the SAME ABS Lending Indicators source as its baked
 * counterpart, so the splice is methodologically continuous; price_to_income's
 * baked spine is the OECD index and the live tail is the ABS-derived index —
 * both rebased to 2015 = 100, joined at the overlap.
 */
export function useLiveYearValues(measure: string, baked: YearValue[]): YearValue[] {
  const { data } = useQuery({
    queryKey: ["housing-series", "AUS", measure, ""],
    queryFn: () => getHousePriceSeriesClient("AUS", measure, ""),
    staleTime: 60 * 60 * 1000,
  });

  return useMemo(() => {
    const pts = data?.points ?? [];
    if (pts.length < 2) return baked;

    const byYear = new Map<number, { sum: number; n: number }>();
    for (const p of pts) {
      const secs = Number(p.period?.seconds ?? 0n);
      if (!secs) continue;
      const year = new Date(secs * 1000).getUTCFullYear();
      const acc = byYear.get(year) ?? { sum: 0, n: 0 };
      acc.sum += p.value;
      acc.n += 1;
      byYear.set(year, acc);
    }
    if (byYear.size === 0) return baked;

    const merged = new Map<number, number>();
    for (const yv of baked) merged.set(yv.year, yv.value);
    for (const [year, { sum, n }] of byYear) merged.set(year, sum / n);

    return [...merged.entries()]
      .map(([year, value]) => ({ year, value }))
      .sort((a, b) => a.year - b.year);
  }, [data, baked]);
}
