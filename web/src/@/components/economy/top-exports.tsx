"use client";

import { useQuery } from "@tanstack/react-query";
import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import { MAP_FORMATS, type StateSlug } from "@/lib/economy/map-metrics";

/**
 * SITC product slugs — MUST match services/economy-collector/trade.go's
 * `sitcProducts` map (verified 2026-07-21 against that file + a local DB
 * cross-check: `SELECT DISTINCT product FROM economic_series WHERE
 * topic='trade'`). "TOT"/"total" is intentionally excluded — that's the
 * aggregate series already shown as "Goods exports"/"Goods imports".
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

/** Top export commodities for a state (SITC single-digit sections), bar-ranked. */
export function TopExports({ state }: { state: StateSlug }) {
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
