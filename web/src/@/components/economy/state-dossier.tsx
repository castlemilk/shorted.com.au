"use client";

import { useQuery } from "@tanstack/react-query";
import { getEconomicSeriesClient } from "@/app/actions/client/getEconomyClient";
import { EconomySeriesChart } from "./economy-charts";
import { MAP_FORMATS, STATE_NAMES, type EconomyMapMetricKey, type StateSlug } from "@/lib/economy/map-metrics";

/**
 * SITC product slugs — MUST match services/economy-collector/trade.go's
 * `sitcProducts` map (verified 2026-07-21 against that file + a local DB
 * cross-check: `SELECT DISTINCT product FROM economic_series WHERE
 * topic='trade'`). "TOT"/"total" is intentionally excluded — that's the
 * aggregate series already shown as "Goods exports"/"Goods imports" above.
 */
const SITC_PRODUCTS: { slug: string; label: string }[] = [
  { slug: "food_and_live_animals", label: "Food & live animals" },
  { slug: "beverages_and_tobacco", label: "Beverages & tobacco" },
  { slug: "crude_materials_inedible_except_fuels", label: "Crude materials" },
  { slug: "mineral_fuels_lubricants_and_related_materials", label: "Mineral fuels" },
  { slug: "animal_and_vegetable_oils_fats_and_waxes", label: "Animal & vegetable oils" },
  { slug: "chemicals_and_related_products_nes", label: "Chemicals" },
  { slug: "manufactured_goods_classified_chiefly_by_material", label: "Manufactured goods" },
  { slug: "machinery_and_transport_equipment", label: "Machinery & transport" },
  { slug: "miscellaneous_manufactured_articles", label: "Misc. manufactured articles" },
  { slug: "commodities_and_transactions_not_classified_elsewhere_in_the_sitc", label: "Other commodities" },
];

const fmtAud = MAP_FORMATS.aud;

function TopExports({ state }: { state: StateSlug }) {
  const keys = SITC_PRODUCTS.map((p) => `trade.export_value.${p.slug}.${state}`);
  const { data } = useQuery({
    queryKey: ["economy-top-exports", state],
    staleTime: 60 * 60 * 1000,
    queryFn: () => getEconomicSeriesClient(keys),
  });
  const rows = (data?.series ?? [])
    .map((s) => {
      const obs = s.observations ?? [];
      const last = obs[obs.length - 1];
      const slug = s.info?.seriesKey.split(".")[2] ?? "";
      return last
        ? { label: SITC_PRODUCTS.find((p) => p.slug === slug)?.label ?? slug, value: last.value }
        : null;
    })
    .filter((r): r is { label: string; value: number } => !!r)
    .sort((a, b) => b.value - a.value);
  if (!rows.length) return null;
  const maxV = rows[0]!.value;
  return (
    <div>
      <h4 className="font-serif text-sm font-semibold">Top export commodities</h4>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2 text-xs">
            <span className="w-40 truncate text-muted-foreground">{r.label}</span>
            <span
              className="h-2 rounded-sm bg-primary/70"
              style={{ width: `${(r.value / maxV) * 100}%`, minWidth: 2 }}
            />
            <span className="font-mono tabular-nums">{fmtAud(r.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const HAS_LABOUR: StateSlug[] = ["nsw", "vic", "qld", "sa", "wa", "tas"];
const HAS_DIESEL: StateSlug[] = ["nsw", "vic", "qld", "sa", "wa", "tas", "nt"];

export function StateDossier({
  state,
  metricKey: _metricKey,
  onClose,
}: {
  state: string;
  metricKey: EconomyMapMetricKey;
  onClose: () => void;
}) {
  const slug = state as StateSlug;
  const name = STATE_NAMES[slug];
  return (
    <section className="mt-4 rounded-xl border border-border bg-card p-4" aria-label={`${name} dossier`}>
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-serif text-xl font-semibold">{name}</h3>
          <p className="text-xs text-muted-foreground">State drill-down · sources: ABS, DCCEEW · CC BY 4.0</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-xs text-muted-foreground hover:text-foreground"
        >
          ✕ close
        </button>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {HAS_LABOUR.includes(slug) && (
          <div>
            <h4 className="mb-1 font-serif text-sm font-semibold">Unemployment rate</h4>
            <EconomySeriesChart
              seriesKey={`labour.unemployment_rate.total.${slug}.seasadj`}
              ariaLabel={`${name} unemployment rate`}
              format="percent"
              height={220}
            />
          </div>
        )}
        <div>
          <h4 className="mb-1 font-serif text-sm font-semibold">State final demand</h4>
          <EconomySeriesChart
            seriesKey={`gdp.state_final_demand_chain_volume.total.${slug}.seasadj`}
            ariaLabel={`${name} state final demand`}
            format="aud"
            height={220}
          />
        </div>
        <div>
          <h4 className="mb-1 font-serif text-sm font-semibold">Goods exports</h4>
          <EconomySeriesChart
            seriesKey={`trade.export_value.total.${slug}`}
            ariaLabel={`${name} goods exports`}
            format="aud"
            height={220}
          />
        </div>
        <div>
          <h4 className="mb-1 font-serif text-sm font-semibold">Goods imports</h4>
          <EconomySeriesChart
            seriesKey={`trade.import_value.total.${slug}`}
            ariaLabel={`${name} goods imports`}
            format="aud"
            height={220}
          />
        </div>
        {HAS_DIESEL.includes(slug) && (
          <div>
            <h4 className="mb-1 font-serif text-sm font-semibold">Diesel sales</h4>
            <EconomySeriesChart
              seriesKey={`petroleum.sales.diesel_oil_total.${slug}`}
              ariaLabel={`${name} diesel sales`}
              format="megalitres"
              height={220}
            />
          </div>
        )}
        <TopExports state={slug} />
      </div>
    </section>
  );
}
