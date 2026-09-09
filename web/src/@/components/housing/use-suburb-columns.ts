"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSuburbIndexClient, getSuburbMetricColumnsClient } from "~/app/actions/client/getHousingClient";
import { decodeColumn } from "@/lib/housing/suburb-columns";

const STALE = 60 * 60 * 1000;

/**
 * One metric column for a state, aligned to the state's suburb index and
 * decoded to Map<sal_code, value | null>. Two small fetches (index once per
 * state, ~18 KB per metric) instead of the 3.6 MB row set; the index query is
 * shared by every column via react-query's cache.
 *
 * `index_version` is the contract: a column built against a different index
 * ordering is refused (returns undefined) rather than silently misaligned.
 */
export function useSuburbColumns(stateCode: string, metricKeys: readonly string[]) {
  const keys = useMemo(() => [...metricKeys].sort(), [metricKeys]);
  const index = useQuery({
    queryKey: ["suburb-index", stateCode],
    queryFn: () => getSuburbIndexClient(stateCode),
    staleTime: STALE,
    enabled: keys.length > 0,
  });
  const columns = useQuery({
    queryKey: ["suburb-columns", stateCode, keys],
    queryFn: () => getSuburbMetricColumnsClient(stateCode, keys),
    staleTime: STALE,
    enabled: keys.length > 0,
  });

  const data = useMemo(() => {
    const idx = index.data;
    const cols = columns.data;
    if (!idx || !cols || !keys.length) return undefined;
    if (idx.indexVersion !== cols.indexVersion) return undefined;
    const salCodes = idx.suburbs.map((s) => s.salCode);
    const out = new Map<string, Map<string, number | null>>();
    for (const col of cols.columns) {
      out.set(col.metricKey, decodeColumn(salCodes, col.values, col.nullMask));
    }
    return out;
  }, [index.data, columns.data, keys]);

  const mismatch = Boolean(index.data && columns.data && index.data.indexVersion !== columns.data.indexVersion);
  return {
    data,
    isLoading: keys.length > 0 && (index.isLoading || columns.isLoading),
    isError: index.isError || columns.isError || mismatch,
    refetch: () => { void index.refetch(); void columns.refetch(); },
  };
}
