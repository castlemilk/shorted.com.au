"use client";

import type { ReactNode } from "react";

import { EconomySeriesChart } from "./economy-charts";
import { StateCompanies } from "./state-companies";
import { TopExports } from "./top-exports";
import { EconomyIcon, type EconomyIconName } from "./economy-icon";
import { hasDiesel, hasLabour } from "./availability";
import { STATE_NAMES, type StateSlug } from "@/lib/economy/map-metrics";

/** Chart header with a warm-duotone economy icon beside the title. */
function ChartHeader({ icon, children }: { icon: EconomyIconName; children: ReactNode }) {
  return (
    <h4 className="mb-1 flex items-center gap-1.5 font-serif text-sm font-semibold">
      <EconomyIcon name={icon} size={18} />
      {children}
    </h4>
  );
}

/**
 * The client chart grid for a state page — the charts, "Operating here" and
 * "Top export commodities" that used to live inside the SPA StateDossier,
 * rebuilt as a standalone section the server page composes below its SSR
 * header. Availability of the labour + diesel series is gated by the shared
 * registry-derived helpers (HAS_LABOUR / HAS_DIESEL).
 */
export function StateCharts({ state }: { state: StateSlug }) {
  const name = STATE_NAMES[state];
  return (
    <section aria-label={`${name} charts`} className="grid gap-4 lg:grid-cols-2">
      {hasLabour(state) && (
        <div>
          <ChartHeader icon="unemployment">Unemployment rate</ChartHeader>
          <EconomySeriesChart
            seriesKey={`labour.unemployment_rate.total.${state}.seasadj`}
            ariaLabel={`${name} unemployment rate`}
            format="percent"
            height={220}
          />
        </div>
      )}
      <div>
        <ChartHeader icon="sfd">State final demand</ChartHeader>
        <EconomySeriesChart
          seriesKey={`gdp.state_final_demand_chain_volume.total.${state}.seasadj`}
          ariaLabel={`${name} state final demand`}
          format="aud"
          height={220}
        />
      </div>
      <div>
        <ChartHeader icon="exports">Goods exports</ChartHeader>
        <EconomySeriesChart
          seriesKey={`trade.export_value.total.${state}`}
          ariaLabel={`${name} goods exports`}
          format="aud"
          height={220}
        />
      </div>
      <div>
        <ChartHeader icon="imports">Goods imports</ChartHeader>
        <EconomySeriesChart
          seriesKey={`trade.import_value.total.${state}`}
          ariaLabel={`${name} goods imports`}
          format="aud"
          height={220}
        />
      </div>
      {hasDiesel(state) && (
        <div>
          <ChartHeader icon="diesel">Diesel sales</ChartHeader>
          <EconomySeriesChart
            seriesKey={`petroleum.sales.diesel_oil_total.${state}`}
            ariaLabel={`${name} diesel sales`}
            format="megalitres"
            height={220}
          />
        </div>
      )}
      <StateCompanies state={state} />
      <TopExports state={state} />
    </section>
  );
}
