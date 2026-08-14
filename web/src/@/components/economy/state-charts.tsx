"use client";

import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";

import { EconomyComparisonChart, EconomySeriesChart } from "./economy-charts";
import { StateCompanies } from "./state-companies";
import { StatePoliticianHoldings } from "./state-politician-holdings";
import { TopExports } from "./top-exports";
import { StateCorrelations } from "./state-correlations";
import { StateCrimeCard } from "./state-crime-card";
import { EconomyIcon, type EconomyIconName } from "./economy-icon";
import { hasDiesel, hasLabour } from "./availability";
import { WhenVisible } from "@/components/housing/when-visible";
import {
  STATE_NAMES,
  type EconomySeriesDisplayFormat,
  type StateSlug,
} from "@/lib/economy/map-metrics";
import { STATE_FINANCE_LINKS } from "@/lib/economy/state-finance-links";

type StateChartDefinition =
  | {
      kind: "single";
      title: string;
      icon: EconomyIconName;
      seriesKeyTemplate: string;
      ariaLabel: string;
      format: EconomySeriesDisplayFormat;
    }
  | {
      kind: "comparison";
      title: string;
      icon: EconomyIconName;
      primaryKeyTemplate: string;
      secondaryKeyTemplate: string;
      primaryLabel: string;
      secondaryLabel: string;
      ariaLabel: string;
      format: EconomySeriesDisplayFormat;
      sharedScale?: boolean;
    };

/** Serializable registry for the round-2 state chart additions. */
const STATE_CHART_REGISTRY: StateChartDefinition[] = [
  {
    kind: "single",
    title: "Household spending",
    icon: "sfd",
    seriesKeyTemplate: "spending.household.total.{state}.seasadj",
    ariaLabel: "household spending",
    format: "aud",
  },
  {
    kind: "comparison",
    title: "New housing lending commitments",
    icon: "cash-rate",
    primaryKeyTemplate:
      "lending.new_commitments.owner_occupier.{state}.seasadj",
    secondaryKeyTemplate: "lending.new_commitments.investor.{state}.seasadj",
    primaryLabel: "Owner-occupier",
    secondaryLabel: "Investor",
    ariaLabel: "new housing lending commitments",
    format: "aud",
    sharedScale: true,
  },
  {
    kind: "single",
    title: "Construction work done",
    icon: "company-footprint",
    seriesKeyTemplate: "construction.work_done.total.{state}.seasadj",
    ariaLabel: "construction work done",
    format: "aud",
  },
];

/** Chart header with a warm-duotone economy icon beside the title. */
function ChartHeader({
  icon,
  children,
}: {
  icon: EconomyIconName;
  children: ReactNode;
}) {
  return (
    <h4 className="mb-1 flex items-center gap-1.5 font-serif text-sm font-semibold">
      <EconomyIcon name={icon} size={18} />
      {children}
    </h4>
  );
}

/**
 * The client chart grid for a state page — the charts, "State finances",
 * short-interest correlations, "Operating here" and "Top export commodities"
 * that used to live inside the SPA StateDossier, rebuilt as a standalone
 * section the server page composes below its SSR header. Availability of the
 * labour + diesel series is gated by the shared registry-derived helpers
 * (HAS_LABOUR / HAS_DIESEL).
 */
export function StateCharts({ state }: { state: StateSlug }) {
  const name = STATE_NAMES[state];
  return (
    <div aria-label={`${name} charts`} className="space-y-8">
      <section className="grid gap-4 lg:grid-cols-2">
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
        <div>
          <ChartHeader icon="trade-balance">Retail turnover</ChartHeader>
          <EconomySeriesChart
            seriesKey={`retail.turnover.total.${state}.seasadj`}
            ariaLabel={`${name} retail turnover`}
            format="aud"
            height={220}
          />
        </div>
        <div>
          <ChartHeader icon="company-footprint">Dwelling approvals</ChartHeader>
          <EconomySeriesChart
            seriesKey={`approvals.dwelling_units.total.${state}`}
            ariaLabel={`${name} dwelling approvals`}
            format="number"
            height={220}
          />
        </div>
        <div>
          <ChartHeader icon="participation">
            Estimated resident population
          </ChartHeader>
          <EconomySeriesChart
            seriesKey={`population.erp.total.${state}`}
            ariaLabel={`${name} estimated resident population`}
            format="number"
            height={220}
          />
        </div>
        {STATE_CHART_REGISTRY.map((chart) => (
          <div key={chart.title}>
            <ChartHeader icon={chart.icon}>{chart.title}</ChartHeader>
            {chart.kind === "single" ? (
              <EconomySeriesChart
                seriesKey={chart.seriesKeyTemplate.replace("{state}", state)}
                ariaLabel={`${name} ${chart.ariaLabel}`}
                format={chart.format}
                height={220}
              />
            ) : (
              <EconomyComparisonChart
                primaryKey={chart.primaryKeyTemplate.replace("{state}", state)}
                secondaryKey={chart.secondaryKeyTemplate.replace(
                  "{state}",
                  state,
                )}
                primaryLabel={chart.primaryLabel}
                secondaryLabel={chart.secondaryLabel}
                ariaLabel={`${name} ${chart.ariaLabel}`}
                format={chart.format}
                height={220}
                sharedScale={chart.sharedScale}
              />
            )}
          </div>
        ))}
      </section>

      <WhenVisible minHeightClassName="h-[340px]">
        <StateCrimeCard state={state} />
      </WhenVisible>

      {/* State finances — ABS Government Finance Statistics. Revenue and
          expenses side-by-side (like quantities → shared read), net operating
          balance as its own diverging-friendly chart. */}
      <section aria-label={`${name} state finances`}>
        <h3 className="mb-3 flex items-center gap-1.5 font-serif text-lg font-semibold">
          <EconomyIcon name="state-finances" size={20} />
          State finances
        </h3>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <ChartHeader icon="state-finances">Total revenue</ChartHeader>
            <EconomySeriesChart
              seriesKey={`govfin.revenue.total.${state}`}
              ariaLabel={`${name} government total revenue`}
              format="aud"
              height={220}
            />
          </div>
          <div>
            <ChartHeader icon="state-finances">Total expenses</ChartHeader>
            <EconomySeriesChart
              seriesKey={`govfin.expenses.total.${state}`}
              ariaLabel={`${name} government total expenses`}
              format="aud"
              height={220}
            />
          </div>
          <div className="lg:col-span-2">
            <ChartHeader icon="state-finances">
              Net operating balance
            </ChartHeader>
            <EconomySeriesChart
              seriesKey={`govfin.net_operating_balance.total.${state}`}
              ariaLabel={`${name} government net operating balance`}
              format="aud_signed"
              height={220}
            />
          </div>
        </div>
        <div className="mt-5 border-t border-border pt-4">
          <h4 className="mb-3 font-mono text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Finances breakdown
          </h4>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0">
              <ChartHeader icon="state-finances">Taxation revenue</ChartHeader>
              <EconomySeriesChart
                seriesKey={`govfin.revenue.taxation.${state}`}
                ariaLabel={`${name} government taxation revenue`}
                format="aud"
                height={160}
              />
            </div>
            <div className="min-w-0">
              <ChartHeader icon="state-finances">Current grants</ChartHeader>
              <EconomySeriesChart
                seriesKey={`govfin.revenue.grants.${state}`}
                ariaLabel={`${name} government grants revenue`}
                format="aud"
                height={160}
              />
            </div>
            <div className="min-w-0">
              <ChartHeader icon="state-finances">Employee expenses</ChartHeader>
              <EconomySeriesChart
                seriesKey={`govfin.expenses.employees.${state}`}
                ariaLabel={`${name} government employee expenses`}
                format="aud"
                height={160}
              />
            </div>
            <div className="min-w-0">
              <ChartHeader icon="state-finances">Interest expenses</ChartHeader>
              <EconomySeriesChart
                seriesKey={`govfin.expenses.interest.${state}`}
                ariaLabel={`${name} government interest expenses`}
                format="aud"
                height={160}
              />
            </div>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Source: ABS Government Finance Statistics (general government,
          quarterly). CC BY 4.0.
        </p>
        <div className="mt-4 border-t border-border pt-4">
          <h4 className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Sources &amp; further reading
          </h4>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {STATE_FINANCE_LINKS[state].map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-10 items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {link.label}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* Short-interest correlations — below the chart grid, above Operating here. */}
      <StateCorrelations state={state} />

      <section className="grid gap-4 lg:grid-cols-2">
        <StateCompanies state={state} />
        <TopExports state={state} />
      </section>

      {/* Register of interests, in its own row rather than squeezed into a
          3-column grid. Already inside state-charts-loader's ssr:false
          boundary, so the connect-web import is safe here. */}
      <section className="grid gap-4 lg:grid-cols-2">
        <StatePoliticianHoldings state={state} />
      </section>
    </div>
  );
}
