import type { ReactNode } from "react";

import {
  HousingComparisonChart,
  HousingSeriesChart,
} from "./housing-charts";
import { HousingIcon, type HousingIconName } from "./housing-icon";
import { WhenVisible } from "./when-visible";

const RATE_SERIES = [
  { measure: "cash_rate", label: "Cash rate" },
  { measure: "mortgage_rate_oo", label: "Owner-occupier mortgage rate" },
  { measure: "mortgage_rate_investor", label: "Investor mortgage rate" },
] as const;

const CREDIT_SERIES = [
  { measure: "housing_credit_growth_oo", label: "Owner-occupier credit" },
  { measure: "housing_credit_growth_investor", label: "Investor credit" },
] as const;

const RENT_WAGE_SERIES = [
  { measure: "rents_index", label: "Rents" },
  { measure: "wage_index", label: "Wages" },
] as const;

const BALANCE_SHEET_SERIES = [
  { measure: "household_dwelling_assets", label: "Dwelling assets" },
  { measure: "household_net_worth", label: "Net worth" },
  { measure: "household_liabilities", label: "Liabilities" },
] as const;

const MEASURE_TILES = [
  {
    icon: "mortgage",
    label: "Rates",
    detail: "Monthly · % p.a.",
    description: "Cash and outstanding owner-occupier and investor mortgage rates.",
  },
  {
    icon: "debt",
    label: "Credit growth",
    detail: "Monthly · annual % change",
    description: "Total housing credit and its owner-occupier and investor split.",
  },
  {
    icon: "income",
    label: "Affordability",
    detail: "Monthly/quarterly · index, YoY & share",
    description: "Rents, wages, price-to-income and investor lending share.",
  },
  {
    icon: "median-price",
    label: "Balance sheet",
    detail: "Quarterly · AUD",
    description: "Household dwelling assets, net worth and liabilities.",
  },
] as const satisfies ReadonlyArray<{
  icon: HousingIconName;
  label: string;
  detail: string;
  description: string;
}>;

function MeasureTile({
  icon,
  label,
  detail,
  description,
}: (typeof MEASURE_TILES)[number]) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <HousingIcon name={icon} size={18} />
        <p className="font-serif text-base text-foreground">{label}</p>
      </div>
      <p className="mt-2 font-mono text-xs text-primary">{detail}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function ChartCard({
  title,
  description,
  source,
  children,
}: {
  title: string;
  description: string;
  source: string;
  children: ReactNode;
}) {
  return (
    <article className="flex h-full flex-col rounded-xl border border-border bg-card p-5">
      <div className="mb-3">
        <h4 className="font-serif text-lg text-foreground">{title}</h4>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="mt-auto">
        <WhenVisible>{children}</WhenVisible>
      </div>
      <p className="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
        Source: {source} · CC BY 4.0
      </p>
    </article>
  );
}

/** National affordability measures fetched lazily through GetHousePriceSeries. */
export function AffordabilityPanel() {
  return (
    <section className="space-y-8" aria-labelledby="affordability-credit-heading">
      <div>
        <h2
          id="affordability-credit-heading"
          className="flex items-center gap-2 font-serif text-2xl text-foreground"
        >
          <HousingIcon name="income" size={22} /> Affordability &amp; credit
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Follow the rates, credit, income and household balance-sheet measures
          that shape how affordable Australian housing feels. Monthly series load
          only as this section approaches the viewport.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {MEASURE_TILES.map((tile) => (
          <MeasureTile key={tile.label} {...tile} />
        ))}
      </div>

      <div className="space-y-4">
        <h3 className="font-serif text-xl text-foreground">Rates &amp; credit</h3>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <ChartCard
              title="Cash and mortgage rates"
              description="The RBA cash-rate target against outstanding owner-occupier and investor housing rates."
              source="RBA Tables F1.1 & F6"
            >
              <HousingComparisonChart
                regionCode="AUS"
                definitions={RATE_SERIES}
                ariaLabel="Australian cash and mortgage rates"
                format="percent"
              />
            </ChartCard>
          </div>
          <ChartCard
            title="Credit growth by borrower"
            description="Annual growth in owner-occupier and investor housing credit on a shared scale."
            source="RBA Table D1"
          >
            <HousingComparisonChart
              regionCode="AUS"
              definitions={CREDIT_SERIES}
              ariaLabel="Australian housing credit growth by borrower"
              format="percent"
            />
          </ChartCard>
          <ChartCard
            title="Total housing credit growth"
            description="Annual growth in the RBA's total housing credit aggregate."
            source="RBA Table D1"
          >
            <HousingSeriesChart
              regionCode="AUS"
              measure="housing_credit_growth"
              ariaLabel="Australian total housing credit growth"
              format="percent"
            />
          </ChartCard>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="font-serif text-xl text-foreground">Affordability</h3>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <ChartCard
              title="Rents and wages"
              description="Annual movement calculated against the same month or quarter one year earlier."
              source="ABS CPI and WPI"
            >
              <HousingComparisonChart
                regionCode="AUS"
                definitions={RENT_WAGE_SERIES}
                ariaLabel="Australian rents and wages annual change"
                format="percent"
                transform="yoy"
              />
            </ChartCard>
          </div>
          <ChartCard
            title="Price to income"
            description="National mean dwelling prices relative to the Wage Price Index, rebased to 2015 = 100."
            source="Shorted-derived from ABS RES_DWELL_ST and WPI"
          >
            <HousingSeriesChart
              regionCode="AUS"
              measure="price_to_income"
              ariaLabel="Australian housing price to income index"
              format="index"
            />
          </ChartCard>
          <ChartCard
            title="Investor share of new lending"
            description="Investor commitments as a share of owner-occupier and investor housing commitments."
            source="ABS LEND_HOUSING"
          >
            <HousingSeriesChart
              regionCode="AUS"
              measure="investor_loan_share"
              ariaLabel="Australian investor share of new housing lending"
              format="percent"
            />
          </ChartCard>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="font-serif text-xl text-foreground">
          Household balance sheet
        </h3>
        <ChartCard
          title="Assets, net worth and liabilities"
          description="The dwelling asset base in context with total household net worth and liabilities."
          source="RBA Table E1"
        >
          <HousingComparisonChart
            regionCode="AUS"
            definitions={BALANCE_SHEET_SERIES}
            ariaLabel="Australian household balance sheet"
            format="aud"
          />
        </ChartCard>
      </div>
    </section>
  );
}
