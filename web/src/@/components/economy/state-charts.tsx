"use client";

import { EconomySeriesChart } from "./economy-charts";
import { StateCompanies } from "./state-companies";
import { TopExports } from "./top-exports";
import { hasDiesel, hasLabour } from "./availability";
import { STATE_NAMES, type StateSlug } from "@/lib/economy/map-metrics";

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
          <h4 className="mb-1 font-serif text-sm font-semibold">Unemployment rate</h4>
          <EconomySeriesChart
            seriesKey={`labour.unemployment_rate.total.${state}.seasadj`}
            ariaLabel={`${name} unemployment rate`}
            format="percent"
            height={220}
          />
        </div>
      )}
      <div>
        <h4 className="mb-1 font-serif text-sm font-semibold">State final demand</h4>
        <EconomySeriesChart
          seriesKey={`gdp.state_final_demand_chain_volume.total.${state}.seasadj`}
          ariaLabel={`${name} state final demand`}
          format="aud"
          height={220}
        />
      </div>
      <div>
        <h4 className="mb-1 font-serif text-sm font-semibold">Goods exports</h4>
        <EconomySeriesChart
          seriesKey={`trade.export_value.total.${state}`}
          ariaLabel={`${name} goods exports`}
          format="aud"
          height={220}
        />
      </div>
      <div>
        <h4 className="mb-1 font-serif text-sm font-semibold">Goods imports</h4>
        <EconomySeriesChart
          seriesKey={`trade.import_value.total.${state}`}
          ariaLabel={`${name} goods imports`}
          format="aud"
          height={220}
        />
      </div>
      {hasDiesel(state) && (
        <div>
          <h4 className="mb-1 font-serif text-sm font-semibold">Diesel sales</h4>
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
