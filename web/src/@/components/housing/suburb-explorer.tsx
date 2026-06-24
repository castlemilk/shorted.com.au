"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  listHousingRegionsClient,
  getHousePriceSeriesClient,
} from "~/app/actions/client/getHousingClient";
import { HousingSeriesChart } from "./housing-series-chart";
import { SuburbMap } from "./suburb-map";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Region = { regionCode: string; regionName: string; stateCode: string; value: number };

const STATE_FILTERS = [
  { code: "", label: "All" },
  { code: "SA", label: "SA" },
  { code: "VIC", label: "VIC" },
];

const MAX_LIST = 300;

function fmtAUD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v)}`;
}

function pointDate(p: { period?: { seconds?: bigint } }): number {
  return Number(p.period?.seconds ?? 0n) * 1000;
}

/**
 * Suburb explorer: search the SA + VIC Valuer-General suburbs (via
 * ListHousingRegions) and plot any suburb's median-price series (via the
 * generic GetHousePriceSeries). Client-only — loaded ssr:false from
 * housing-charts.tsx because it pulls in connect-web.
 */
export function SuburbExplorer() {
  const [stateFilter, setStateFilter] = useState("VIC");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  // State is filtered SERVER-SIDE: the selected state_code is passed to
  // ListHousingRegions so the SQL WHERE narrows the result set. (Previously the
  // client fetched all suburbs with an empty state_code and tried to filter in
  // memory, which let mixed SA+VIC results through.)
  const { data: regionsResp, isLoading } = useQuery({
    queryKey: ["housing-regions", "suburb", stateFilter],
    queryFn: () => listHousingRegionsClient("suburb", stateFilter, "", 2000),
    staleTime: 60 * 60 * 1000,
  });

  const regions: Region[] = useMemo(
    () =>
      (regionsResp?.regions ?? []).map((r) => ({
        regionCode: r.regionCode,
        regionName: r.regionName,
        stateCode: r.stateCode,
        value: r.latestValue ?? 0,
      })),
    [regionsResp],
  );

  // Server already narrows by state_code; this stays as a defensive guard
  // (and a no-op pass-through for the "All" selection).
  const stateFiltered = useMemo(
    () => regions.filter((r) => !stateFilter || r.stateCode === stateFilter),
    [regions, stateFilter],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stateFiltered.filter((r) => !q || r.regionName.toLowerCase().includes(q));
  }, [stateFiltered, search]);

  const active = useMemo(
    () => stateFiltered.find((r) => r.regionCode === selected) ?? filtered[0],
    [stateFiltered, selected, filtered],
  );
  const activeCode = active?.regionCode;

  const { data: series } = useQuery({
    queryKey: ["housing-series", activeCode ?? "", "median_price", "house"],
    queryFn: () => getHousePriceSeriesClient(activeCode!, "median_price", "house"),
    enabled: !!activeCode,
    staleTime: 60 * 60 * 1000,
  });

  const stat = useMemo(() => {
    const pts = [...(series?.points ?? [])].sort((a, b) => pointDate(a) - pointDate(b));
    if (pts.length === 0) return null;
    const last = pts[pts.length - 1]!;
    // nearest point ~1 year before the latest
    const target = pointDate(last) - 365 * 24 * 3600 * 1000;
    let prior = pts[0]!;
    for (const p of pts) {
      if (pointDate(p) <= target) prior = p;
    }
    const yoy = prior && prior !== last && prior.value > 0 ? ((last.value - prior.value) / prior.value) * 100 : null;
    return { latest: last.value, asOf: new Date(pointDate(last)), yoy };
  }, [series]);

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      {/* selector */}
      <div className="flex flex-col rounded-xl border border-border bg-card">
        <div className="space-y-3 border-b border-border p-4">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search suburb…"
            aria-label="Search suburb"
          />
          <div className="flex gap-1">
            {STATE_FILTERS.map((s) => (
              <button
                key={s.label}
                onClick={() => setStateFilter(s.code)}
                className={cn(
                  "flex-1 rounded-md border px-2 py-1 font-mono text-xs transition-colors",
                  stateFilter === s.code
                    ? "border-[color:var(--accent-amber,theme(colors.amber.500))] bg-amber-500/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {isLoading ? "Loading suburbs…" : `${filtered.length} suburb${filtered.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="max-h-[420px] overflow-y-auto p-2">
          {filtered.slice(0, MAX_LIST).map((r) => (
            <button
              key={r.regionCode}
              onClick={() => setSelected(r.regionCode)}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors",
                r.regionCode === activeCode ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              <span className="truncate capitalize">{r.regionName.toLowerCase()}</span>
              <span className="ml-2 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {r.value > 0 ? fmtAUD(r.value) : r.stateCode}
              </span>
            </button>
          ))}
          {filtered.length > MAX_LIST ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              +{filtered.length - MAX_LIST} more — refine your search
            </p>
          ) : null}
        </div>
      </div>

      {/* right column: state map + selected-suburb detail */}
      <div className="space-y-6">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3">
            <h3 className="font-serif text-lg text-foreground">
              {stateFilter === "SA" ? "South Australia" : stateFilter === "VIC" ? "Victoria" : "SA & VIC"} · median by suburb
            </h3>
            <p className="text-xs text-muted-foreground">
              Each suburb shaded by its latest median price — click a cell to inspect its history.
            </p>
          </div>
          <SuburbMap regions={stateFiltered} selectedCode={activeCode} onSelect={setSelected} />
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          {active ? (
          <>
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="font-serif text-2xl capitalize text-foreground">{active.regionName.toLowerCase()}</h3>
                <p className="text-xs text-muted-foreground">
                  {active.stateCode} · median house price · {active.stateCode === "SA" ? "quarterly" : "annual"}
                </p>
              </div>
              {stat ? (
                <div className="text-right">
                  <div className="font-mono text-2xl font-semibold tabular-nums text-foreground">{fmtAUD(stat.latest)}</div>
                  {stat.yoy != null ? (
                    <div
                      className={cn(
                        "font-mono text-sm tabular-nums",
                        stat.yoy >= 0 ? "text-[color:var(--semantic-green)]" : "text-[color:var(--semantic-red)]",
                      )}
                    >
                      {stat.yoy >= 0 ? "+" : ""}
                      {stat.yoy.toFixed(1)}% yr
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <HousingSeriesChart
              regionCode={active.regionCode}
              measure="median_price"
              dwellingType="house"
              ariaLabel={`${active.regionName} median house price`}
              format="aud"
              height={320}
            />
          </>
        ) : (
          <div className="flex h-[360px] items-center justify-center text-sm text-muted-foreground">
            Select a suburb to see its median-price history.
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
