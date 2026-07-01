"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { listStateSuburbsClient } from "~/app/actions/client/getHousingClient";
import { StateSuburbMap, type SuburbDatum } from "./state-suburb-map";
import { DataAttribution } from "./data-attribution";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { STATE_NAMES, suburbHref } from "@/lib/housing/states";
import { fmtPriceShort } from "@/lib/housing/price-scale";

const MAX_LIST = 400;
const fmtCompact = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : `${v}`;

type SortKey = "price" | "name" | "population";

export function StateSuburbExplorer({ stateCode }: { stateCode: string }) {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["state-suburbs", stateCode],
    queryFn: () => listStateSuburbsClient(stateCode, "", 5000),
    staleTime: 60 * 60 * 1000,
  });
  const suburbs: SuburbDatum[] = useMemo(
    () => (data?.suburbs ?? []).map((s) => ({
      salCode: s.salCode, salName: s.salName, postcode: s.postcode,
      latestMedianPrice: s.latestMedianPrice, yoyPct: s.yoyPct,
      population: s.population, medianAge: s.medianAge, medianWeeklyHhdIncome: s.medianWeeklyHhdIncome,
      pctBornOverseas: s.pctBornOverseas, topReligion: s.topReligion,
      topLanguage: s.topLanguage, pctTopLanguage: s.pctTopLanguage,
      federalDivision: s.federalDivision, federalMember: s.federalMember,
      federalParty: s.federalParty, federalPartyAb: s.federalPartyAb, federalTppAlp: s.federalTppAlp,
      stateDistrict: s.stateDistrict, stateMember: s.stateMember,
      stateParty: s.stateParty, statePartyAb: s.statePartyAb,
      regionCode: s.regionCode,
      schoolsTotal: s.amenities?.schoolsTotal ?? 0,
      supermarketsTotal: s.amenities?.supermarketsTotal ?? 0,
      colesCount: s.amenities?.colesCount ?? 0, woolworthsCount: s.amenities?.woolworthsCount ?? 0,
      aldiCount: s.amenities?.aldiCount ?? 0, igaCount: s.amenities?.igaCount ?? 0,
      pubsBars: s.amenities?.pubsBars ?? 0, parksCount: s.amenities?.parksCount ?? 0,
      librariesCount: s.amenities?.librariesCount ?? 0,
      nearestSupermarketKm: s.amenities?.nearestSupermarketKm ?? 0,
      amenityDensityScore: s.amenities?.amenityDensityScore ?? 0,
      hospitalsCount: s.amenities?.hospitalsCount ?? 0, gpCount: s.amenities?.gpCount ?? 0,
      pharmacyCount: s.amenities?.pharmacyCount ?? 0,
      nearestTrainKm: s.amenities?.nearestTrainKm ?? 0, nearestHospitalKm: s.amenities?.nearestHospitalKm ?? 0,
      distToCoastKm: s.amenities?.distToCoastKm ?? 0,
      dominantNbnTech: s.dominantNbnTech, connectivityQualityScore: s.connectivityQualityScore,
    })),
    [data],
  );

  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("price");
  const [pricedOnly, setPricedOnly] = useState(false);
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  // ?sal= (e.g. from a suburb profile's "view on map") pre-selects + frames a suburb
  const [selected, setSelected] = useState<string | undefined>(searchParams.get("sal") ?? undefined);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const stats = useMemo(() => {
    const priced = suburbs.filter((s) => s.latestMedianPrice > 0).map((s) => s.latestMedianPrice).sort((a, b) => a - b);
    const pop = suburbs.reduce((a, s) => a + (s.population || 0), 0);
    const median = priced.length ? priced[Math.floor(priced.length / 2)]! : 0;
    return {
      total: suburbs.length, pricedCount: priced.length, population: pop, median,
      min: priced[0] ?? 0, max: priced[priced.length - 1] ?? 0,
    };
  }, [suburbs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = suburbs.filter((s) => (!q || s.salName.toLowerCase().includes(q)) && (!pricedOnly || s.latestMedianPrice > 0));
    out = [...out].sort((a, b) => {
      if (sortBy === "name") return a.salName.localeCompare(b.salName);
      if (sortBy === "population") return b.population - a.population;
      // price: priced desc, unpriced last (then by name)
      if ((a.latestMedianPrice > 0) !== (b.latestMedianPrice > 0)) return a.latestMedianPrice > 0 ? -1 : 1;
      if (a.latestMedianPrice !== b.latestMedianPrice) return b.latestMedianPrice - a.latestMedianPrice;
      return a.salName.localeCompare(b.salName);
    });
    return out;
  }, [suburbs, search, sortBy, pricedOnly]);

  // selection/hover (or ?sal= deep-link) → scroll the matching list row into view.
  // depend on `filtered` so a deep-link set before rows render still scrolls once they do.
  useEffect(() => {
    const target = selected ?? hovered;
    if (!target) return;
    rowRefs.current.get(target)?.scrollIntoView({ block: "nearest" });
  }, [selected, hovered, filtered]);

  const goToSuburb = (s: SuburbDatum) => router.push(suburbHref(stateCode, s));
  const noPrice = !isLoading && stats.pricedCount === 0;

  if (isError) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">Couldn&apos;t load {STATE_NAMES[stateCode]} suburbs.</p>
        <button onClick={() => void refetch()} className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* state summary stat-strip */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
        <Stat label="Suburbs priced" value={isLoading ? "…" : `${stats.pricedCount.toLocaleString()} / ${stats.total.toLocaleString()}`} />
        <Stat label="Median (priced)" value={isLoading ? "…" : stats.median > 0 ? fmtPriceShort(stats.median) : "—"} />
        <Stat label="Price range" value={isLoading ? "…" : stats.max > 0 ? `${fmtPriceShort(stats.min)}–${fmtPriceShort(stats.max)}` : "—"} />
        <Stat label="Population" value={isLoading ? "…" : `${fmtCompact(stats.population)}`} />
      </div>

      {noPrice ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs text-muted-foreground">
          No suburb price data for {STATE_NAMES[stateCode]} yet — showing ABS Census demographics.
          Valuer-General price coverage currently spans <strong className="text-foreground">SA &amp; VIC</strong>.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        {/* left: search + controls + list */}
        <div className="order-last flex flex-col rounded-xl border border-border bg-card lg:order-first">
          <div className="space-y-2.5 border-b border-border p-4">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${STATE_NAMES[stateCode]} suburb…`} aria-label="Search suburb" />
            <div className="flex items-center gap-2">
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
                <SelectTrigger className="h-8 flex-1 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="price">Sort: Price</SelectItem>
                  <SelectItem value="name">Sort: Name</SelectItem>
                  <SelectItem value="population">Sort: Population</SelectItem>
                </SelectContent>
              </Select>
              <button
                type="button" onClick={() => setPricedOnly((p) => !p)}
                aria-pressed={pricedOnly}
                className={cn("h-8 shrink-0 rounded-md border px-2.5 text-xs transition-colors",
                  pricedOnly ? "border-foreground/30 bg-foreground/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
              >
                Priced only
              </button>
            </div>
            <p className="text-xs text-muted-foreground">{isLoading ? "Loading suburbs…" : `${filtered.length.toLocaleString()} suburb${filtered.length === 1 ? "" : "s"}`}</p>
          </div>
          <div className="max-h-[320px] overflow-y-auto p-2 lg:max-h-[520px]">
            {filtered.slice(0, MAX_LIST).map((s) => {
              const priced = s.latestMedianPrice > 0;
              return (
                <button key={s.salCode}
                  ref={(el) => { if (el) rowRefs.current.set(s.salCode, el); }}
                  onMouseEnter={() => setHovered(s.salCode)}
                  onMouseLeave={() => setHovered(undefined)}
                  onClick={() => setSelected(s.salCode)}
                  onDoubleClick={() => goToSuburb(s)}
                  aria-pressed={s.salCode === selected}
                  className={cn("flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                    s.salCode === selected ? "bg-foreground/10 font-medium text-foreground ring-1 ring-foreground/20"
                      : s.salCode === hovered ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/50")}>
                  <span className="truncate capitalize">{s.salName.toLowerCase()}</span>
                  {priced ? (
                    <span className="ml-2 shrink-0 font-mono text-[11px] tabular-nums text-foreground">{fmtPriceShort(s.latestMedianPrice)}</span>
                  ) : (
                    <span className="ml-2 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">{s.population > 0 ? `${fmtCompact(s.population)} ppl` : "—"}</span>
                  )}
                </button>
              );
            })}
            {filtered.length > MAX_LIST ? <p className="px-3 py-2 text-xs text-muted-foreground">+{(filtered.length - MAX_LIST).toLocaleString()} more — refine your search</p> : null}
            {!isLoading && filtered.length === 0 ? <p className="px-3 py-6 text-center text-xs text-muted-foreground">No suburbs match.</p> : null}
          </div>
        </div>

        {/* right: map */}
        <div className="flex flex-col rounded-xl border border-border bg-card p-3 sm:p-5">
          <StateSuburbMap
            stateCode={stateCode}
            suburbs={suburbs}
            selectedSalCode={selected}
            hoveredSalCode={hovered}
            onHover={(sal) => setHovered(sal ?? undefined)}
            onSelect={(sal) => setSelected(sal ?? undefined)}
            onOpenProfile={(sal) => {
              const s = suburbs.find((x) => x.salCode === sal);
              if (s) goToSuburb(s);
            }}
          />
          <DataAttribution />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card p-3 sm:p-4">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-base font-semibold tabular-nums text-foreground sm:text-lg">{value}</div>
    </div>
  );
}
