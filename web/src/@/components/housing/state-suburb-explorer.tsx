"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { listStateSuburbsClient } from "~/app/actions/client/getHousingClient";
import { StateSuburbMap, type SuburbDatum } from "./state-suburb-map";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { STATE_NAMES, stateSlug } from "@/lib/housing/states";

const MAX_LIST = 400;
const slugifySuburb = (name: string, postcode: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${postcode}`;
const fmtAUD = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);

export function StateSuburbExplorer({ stateCode }: { stateCode: string }) {
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["state-suburbs", stateCode],
    queryFn: () => listStateSuburbsClient(stateCode, "", 5000),
    staleTime: 60 * 60 * 1000,
  });
  const suburbs: SuburbDatum[] = useMemo(
    () => (data?.suburbs ?? []).map((s) => ({
      salCode: s.salCode, salName: s.salName, postcode: s.postcode,
      latestMedianPrice: s.latestMedianPrice, yoyPct: s.yoyPct,
      population: s.population, medianAge: s.medianAge, medianWeeklyHhdIncome: s.medianWeeklyHhdIncome,
      regionCode: s.regionCode,
    })),
    [data],
  );
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | undefined>(undefined);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return suburbs.filter((s) => !q || s.salName.toLowerCase().includes(q));
  }, [suburbs, search]);

  const goToSuburb = (s: SuburbDatum) =>
    router.push(`/housing/${stateSlug(stateCode)}/${slugifySuburb(s.salName, s.postcode)}?sal=${s.salCode}`);

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <div className="flex flex-col rounded-xl border border-border bg-card">
        <div className="space-y-3 border-b border-border p-4">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${STATE_NAMES[stateCode]} suburb…`} aria-label="Search suburb" />
          <p className="text-xs text-muted-foreground">{isLoading ? "Loading suburbs…" : `${filtered.length} suburbs`}</p>
        </div>
        <div className="max-h-[460px] overflow-y-auto p-2">
          {filtered.slice(0, MAX_LIST).map((s) => (
            <button key={s.salCode}
              onMouseEnter={() => setSelected(s.salCode)}
              onClick={() => goToSuburb(s)}
              className={cn("flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors",
                s.salCode === selected ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50")}>
              <span className="truncate capitalize">{s.salName.toLowerCase()}</span>
              <span className="ml-2 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {s.latestMedianPrice > 0 ? fmtAUD(s.latestMedianPrice) : "—"}
              </span>
            </button>
          ))}
          {filtered.length > MAX_LIST ? <p className="px-3 py-2 text-xs text-muted-foreground">+{filtered.length - MAX_LIST} more — refine your search</p> : null}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <StateSuburbMap stateCode={stateCode} suburbs={suburbs} selectedSalCode={selected} onSelect={(sal) => {
          const s = suburbs.find((x) => x.salCode === sal);
          if (s) goToSuburb(s);
        }} />
      </div>
    </div>
  );
}
