"use client";

import { useQuery } from "@tanstack/react-query";
import { getSuburbProfileClient } from "~/app/actions/client/getHousingClient";
import { HousingSeriesChart } from "./housing-series-chart";

const fmtAUD = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);
// Precise dollars for weekly/monthly amounts (incomes, rent) — k-rounding is misleading at this scale.
const fmtMoney = (v: number) => `$${Math.round(v).toLocaleString()}`;

export function SuburbProfile({ salCode, regionCode }: { salCode: string; regionCode?: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["suburb-profile", salCode],
    queryFn: () => getSuburbProfileClient(salCode),
    staleTime: 60 * 60 * 1000,
  });
  if (isLoading) return <div className="h-[520px] w-full animate-pulse rounded-xl bg-muted" />;
  const p = data;
  if (!p?.summary) return <p className="text-sm text-muted-foreground">No data for this suburb yet.</p>;
  const s = p.summary, d = p.demographics, b = p.baselines;
  // Prefer the region_code carried on the profile (lights up the price series for priced suburbs).
  const chartRegion = s.regionCode || regionCode;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-4xl font-semibold capitalize text-foreground">{s.salName.toLowerCase()}</h1>
          <p className="text-sm text-muted-foreground">{s.stateCode} · {s.postcode}</p>
        </div>
        {s.latestMedianPrice > 0 ? (
          <div className="text-right">
            <div className="font-mono text-3xl font-semibold tabular-nums text-foreground">{fmtAUD(s.latestMedianPrice)}</div>
            {s.yoyPct !== 0 ? <div className={s.yoyPct >= 0 ? "text-[color:var(--semantic-green)]" : "text-[color:var(--semantic-red)]"}>{s.yoyPct >= 0 ? "+" : ""}{s.yoyPct.toFixed(1)}% yr</div> : null}
          </div>
        ) : null}
      </div>

      {chartRegion ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 font-serif text-lg text-foreground">Median house price</h2>
          <HousingSeriesChart regionCode={chartRegion} measure="median_price" dwellingType="house" ariaLabel={`${s.salName} median house price`} format="aud" height={300} />
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Population" value={d?.population ? d.population.toLocaleString() : "—"} />
        <Stat label="Median age" value={d?.medianAge ? String(d.medianAge) : "—"} />
        <Stat label="Hhd income / wk" value={d?.medianWeeklyHhdIncome ? fmtMoney(d.medianWeeklyHhdIncome) : "—"} />
        <Stat label="Median rent / wk" value={d?.medianWeeklyRent ? fmtMoney(d.medianWeeklyRent) : "—"} />
        <Stat label="Owned outright" value={d?.pctOwnedOutright ? `${d.pctOwnedOutright.toFixed(0)}%` : "—"} />
        <Stat label="With mortgage" value={d?.pctOwnedMortgage ? `${d.pctOwnedMortgage.toFixed(0)}%` : "—"} />
        <Stat label="Rented" value={d?.pctRented ? `${d.pctRented.toFixed(0)}%` : "—"} />
        <Stat label="Dwellings" value={d?.dwellingCount ? d.dwellingCount.toLocaleString() : "—"} />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 font-serif text-lg text-foreground">vs state &amp; nation</h2>
        <CompareBar label="Median price" suburb={s.latestMedianPrice} state={b?.stateMedianPrice ?? 0} nation={b?.nationalMedianPrice ?? 0} fmt={fmtAUD} />
        <CompareBar label="Hhd income / wk" suburb={d?.medianWeeklyHhdIncome ?? 0} state={b?.stateMedianWeeklyHhdIncome ?? 0} nation={b?.nationalMedianWeeklyHhdIncome ?? 0} fmt={fmtMoney} />
      </div>

      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4 text-xs text-muted-foreground">
        Rental yield & days-on-market coming soon (from property-portal data).
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-card p-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-mono text-xl tabular-nums text-foreground">{value}</div></div>;
}

function CompareBar({ label, suburb, state, nation, fmt }: { label: string; suburb: number; state: number; nation: number; fmt: (v: number) => string }) {
  const max = Math.max(suburb, state, nation, 1);
  const Row = ({ name, v, cls }: { name: string; v: number; cls: string }) => (
    <div className="flex items-center gap-2 py-1 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">{name}</span>
      <div className="h-3 flex-1 rounded bg-muted"><div className={cls} style={{ width: `${(v / max) * 100}%`, height: "100%", borderRadius: 4 }} /></div>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums">{v > 0 ? fmt(v) : "—"}</span>
    </div>
  );
  return (
    <div className="mb-3">
      <div className="mb-1 text-sm text-foreground">{label}</div>
      <Row name="Suburb" v={suburb} cls="bg-[color:var(--accent-amber,#f59e0b)]" />
      <Row name="State" v={state} cls="bg-foreground/40" />
      <Row name="Nation" v={nation} cls="bg-foreground/20" />
    </div>
  );
}
