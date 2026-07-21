"use client";

import { useQuery } from "@tanstack/react-query";
import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import { MAP_FORMATS, type StateSlug } from "@/lib/economy/map-metrics";
import { EconomyIcon, type EconomyIconName } from "./economy-icon";

/**
 * SITC product slugs — MUST match services/economy-collector/trade.go's
 * `sitcProducts` map (verified 2026-07-21 against that file + a local DB
 * cross-check: `SELECT DISTINCT product FROM economic_series WHERE
 * topic='trade'`). "TOT"/"total" is intentionally excluded — that's the
 * aggregate series already shown as "Goods exports"/"Goods imports".
 */
const SITC_PRODUCTS: { slug: string; label: string; icon: EconomyIconName }[] = [
  { slug: "food_and_live_animals", label: "Food & live animals", icon: "food" },
  { slug: "beverages_and_tobacco", label: "Beverages & tobacco", icon: "beverages-tobacco" },
  { slug: "crude_materials_inedible_except_fuels", label: "Crude materials", icon: "crude-materials" },
  { slug: "mineral_fuels_lubricants_and_related_materials", label: "Mineral fuels", icon: "mineral-fuels" },
  { slug: "animal_and_vegetable_oils_fats_and_waxes", label: "Animal & vegetable oils", icon: "oils-fats" },
  { slug: "chemicals_and_related_products_nes", label: "Chemicals", icon: "chemicals" },
  { slug: "manufactured_goods_classified_chiefly_by_material", label: "Manufactured goods", icon: "manufactured-goods" },
  { slug: "machinery_and_transport_equipment", label: "Machinery & transport", icon: "machinery-transport" },
  { slug: "miscellaneous_manufactured_articles", label: "Misc. manufactured articles", icon: "misc-manufactures" },
  { slug: "commodities_and_transactions_not_classified_elsewhere_in_the_sitc", label: "Other commodities", icon: "other-commodities" },
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
      const product = SITC_PRODUCTS.find((p) => p.slug === slug);
      return last && product
        ? { label: product.label, icon: product.icon, value: last.value }
        : null;
    })
    .filter((r): r is { label: string; icon: EconomyIconName; value: number } => !!r)
    .sort((a, b) => b.value - a.value);
  if (!rows.length) return null;
  const maxV = rows[0]!.value;
  return (
    <div>
      <h4 className="font-serif text-sm font-semibold">Top export commodities</h4>
      {/* Strict CSS grid — icon | label | bar-track | value — so every row
          (incl. the first) shares the same column edges; the bar scales as a
          width % within its own 1fr cell rather than pushing the value column. */}
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.label}
            className="grid grid-cols-[1.25rem_10rem_1fr_auto] items-center gap-2 text-xs"
          >
            <EconomyIcon name={r.icon} size={18} />
            <span className="truncate text-muted-foreground">{r.label}</span>
            <span className="h-2 min-w-0">
              <span
                className="block h-2 rounded-sm bg-primary/70"
                style={{ width: `${(r.value / maxV) * 100}%`, minWidth: 2 }}
              />
            </span>
            <span className="text-right font-mono tabular-nums">{fmtAud(r.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
