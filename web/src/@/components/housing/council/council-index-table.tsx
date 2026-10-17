"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type { CouncilMapRow } from "../council-level-map";
import { councilHref, fmtDensity } from "@/lib/housing/council";
import { fmtInt, fmtSharePct, fmtSignedPct } from "@/lib/housing/council-page";
import { fmtPriceShort } from "@/lib/housing/price-scale";

/** One ListCouncils row as plain JSON (what the server page passes). */
export type CouncilIndexRow = CouncilMapRow;

type SortKey =
  | "name" | "population" | "growth" | "density" | "median" | "fag" | "approvals" | "irsad" | "flood" | "bushfire";

interface Column {
  key: SortKey;
  label: string;
  value: (c: CouncilIndexRow) => number | string | null;
  cell: (c: CouncilIndexRow) => React.ReactNode;
  numeric: boolean;
}

/**
 * The state council index table, sortable by any column. Missing facts are
 * blank and always sort last in either direction — an absent council median
 * is "no source", not a zero, so it must never top an ascending sort.
 */
export function CouncilIndexTable({
  stateCode, councils, erpYear, medianPeriod, fagYear,
}: {
  stateCode: string;
  councils: readonly CouncilIndexRow[];
  erpYear?: number;
  medianPeriod?: string;
  fagYear?: string;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "population", desc: true });
  const anyHazard = councils.some((c) => c.floodSharePct !== undefined || c.bushfireSharePct !== undefined);

  const columns = useMemo((): Column[] => {
    const cols: Column[] = [
      {
        key: "name", label: "Council", numeric: false, value: (c) => c.displayName,
        cell: (c) => {
          const href = councilHref(stateCode, c.slug, true);
          return (
            <>
              {href ? <Link href={href} className="font-medium hover:underline">{c.displayName}</Link> : c.displayName}
              {c.kind === "unincorporated" ? <span className="ml-1.5 text-[10px] text-muted-foreground">unincorporated</span> : null}
            </>
          );
        },
      },
      {
        key: "population", label: `Population${erpYear ? ` (${erpYear})` : ""}`, numeric: true,
        value: (c) => (c.population > 0 ? c.population : null), cell: (c) => (c.population > 0 ? fmtInt(c.population) : ""),
      },
      {
        key: "growth", label: "Growth", numeric: true, value: (c) => c.popGrowthPct ?? null,
        cell: (c) => (c.popGrowthPct !== undefined ? fmtSignedPct(c.popGrowthPct) : ""),
      },
      {
        key: "density", label: "Per km²", numeric: true, value: (c) => c.densityPerSqkm ?? null,
        cell: (c) => (c.densityPerSqkm !== undefined ? fmtDensity(c.densityPerSqkm) : ""),
      },
      {
        key: "median", label: `House median${medianPeriod ? ` (${medianPeriod})` : ""}`, numeric: true,
        value: (c) => (c.councilHouseMedian !== undefined && c.councilHouseMedianPeriod ? c.councilHouseMedian : null),
        cell: (c) =>
          c.councilHouseMedian !== undefined && c.councilHouseMedianPeriod
            ? `${fmtPriceShort(c.councilHouseMedian)}${c.councilHouseMedianPeriod !== medianPeriod ? ` (${c.councilHouseMedianPeriod})` : ""}`
            : "",
      },
      {
        key: "fag", label: `Grant / resident${fagYear ? ` (${fagYear})` : ""}`, numeric: true,
        value: (c) => (c.fagPerResident !== undefined && c.fagYear ? c.fagPerResident : null),
        cell: (c) =>
          c.fagPerResident !== undefined && c.fagYear
            ? `$${fmtInt(c.fagPerResident)}${c.fagYear !== fagYear ? ` (${c.fagYear})` : ""}`
            : "",
      },
      {
        key: "approvals", label: "Approvals / 1,000", numeric: true,
        value: (c) => (c.approvalsThrough ? (c.approvalsPer1000 ?? null) : null),
        cell: (c) => (c.approvalsPer1000 !== undefined && c.approvalsThrough ? c.approvalsPer1000.toFixed(1) : ""),
      },
      {
        key: "irsad", label: "IRSAD", numeric: true, value: (c) => c.seifaIrsadDecile ?? null,
        cell: (c) => c.seifaIrsadDecile ?? "",
      },
    ];
    if (anyHazard) {
      cols.push(
        {
          key: "flood", label: "Flood", numeric: true, value: (c) => c.floodSharePct ?? null,
          cell: (c) => (c.floodSharePct !== undefined ? fmtSharePct(c.floodSharePct) : "–"),
        },
        {
          key: "bushfire", label: "Bushfire", numeric: true, value: (c) => c.bushfireSharePct ?? null,
          cell: (c) => (c.bushfireSharePct !== undefined ? fmtSharePct(c.bushfireSharePct) : "–"),
        },
      );
    }
    return cols;
  }, [stateCode, erpYear, medianPeriod, fagYear, anyHazard]);

  const rows = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key) ?? columns[0]!;
    const dir = sort.desc ? -1 : 1;
    return [...councils].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (va == null && vb == null) return a.displayName.localeCompare(b.displayName);
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === "string" || typeof vb === "string"
        ? String(va).localeCompare(String(vb))
        : va - vb;
      return cmp !== 0 ? cmp * dir : a.displayName.localeCompare(b.displayName);
    });
  }, [councils, columns, sort]);

  const toggle = (key: SortKey, numeric: boolean) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: numeric }));

  return (
    <div className="overflow-x-auto rounded-xl border border-border/60">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            {columns.map((col) => {
              const active = sort.key === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
                  className={`px-3 py-2 font-medium${col.numeric ? " text-right" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggle(col.key, col.numeric)}
                    className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground${active ? " text-foreground" : ""}`}
                  >
                    {col.label}
                    <span aria-hidden className="text-[9px]">{active ? (sort.desc ? "▼" : "▲") : ""}</span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.lgaCode} className="border-t border-border/40">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-3 py-1.5${col.numeric ? " text-right tabular-nums" : ""}${col.key === "flood" || col.key === "bushfire" ? " text-muted-foreground" : ""}`}
                >
                  {col.cell(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
