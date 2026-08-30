/**
 * MapLegend stories — visual coverage for the choropleth COLOUR SCALE.
 *
 * Why this file exists: the map's colour scale had no visual coverage at all.
 * #514 changed how every suburb is coloured (anchoring the domain on a
 * percentile instead of the raw maximum, which moved the median NSW suburb from
 * 9.5% to ~47% of the ramp) and #517 changed the implementation underneath it —
 * and the visual regression suite passed both without comment, because nothing
 * rendered the ramp.
 *
 * The legend is the cheap place to cover it. It samples the SAME scale the map
 * paints with, so a screenshot of the gradient bar is a screenshot of the
 * choropleth's colours, without needing topojson, a projection or a map render.
 *
 * Domains below are the real measured NSW distribution (2,433 priced suburbs,
 * 2026-08-28): min $60k, median $1.0M, p98 $4.5M, max $110.5M. Using the actual
 * numbers means the "before" and "after" stories show what the map genuinely
 * looked like, not an invented illustration.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { MapLegend } from "./map-legend";
import { makePriceScale, fmtPriceShort } from "~/@/lib/housing/price-scale";
import { amberScale } from "~/@/lib/housing/highlight-metrics";

const NSW_MIN = 60_000;
const NSW_P98 = 4_514_396;
const NSW_RAW_MAX = 110_500_000;

const meta = {
  title: "Housing/MapLegend",
  component: MapLegend,
  parameters: { layout: "centered" },
} satisfies Meta<typeof MapLegend>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shipped price ramp: domain clamped to the p98, so the legend's top tick
 * reads "≥ $4.5M" and the gradient spends its range on the suburbs people
 * actually look at.
 */
export const PriceClamped: Story = {
  args: {
    colorScale: makePriceScale(NSW_P98),
    min: NSW_MIN,
    max: NSW_P98,
    clamped: true,
    label: "Median house price",
    format: fmtPriceShort,
  },
};

/**
 * The pre-#514 behaviour, kept as a story on purpose: the domain anchored on
 * the raw $110.5M maximum. Nearly the whole bar sits at the pale end, because
 * every real suburb lives in the bottom tenth of it. This is what a regression
 * would look like, and having it side by side makes the clamped version's
 * screenshot meaningful rather than merely present.
 */
export const PriceAnchoredOnRawMaximum: Story = {
  args: {
    colorScale: makePriceScale(NSW_RAW_MAX),
    min: NSW_MIN,
    max: NSW_RAW_MAX,
    clamped: false,
    label: "Median house price (raw max — pre-#514)",
    format: fmtPriceShort,
  },
};

/**
 * A non-price continuous metric on the amber ramp, with a bounded domain and no
 * clamp, so the "≥" affordance is covered in both its present and absent forms.
 */
export const PercentageMetric: Story = {
  args: {
    colorScale: amberScale(0, 100),
    min: 0,
    max: 100,
    clamped: false,
    label: "Rented (% of dwellings)",
    format: (v: number) => `${Math.round(v)}%`,
    showNoData: false,
  },
};

/**
 * The no-data affordance — the hatch swatch that explains grey suburbs. QLD and
 * WA have no priced suburbs at all, so this state is what those maps show for
 * the price metric, not an edge case.
 */
export const WithNoDataSwatch: Story = {
  args: {
    colorScale: makePriceScale(NSW_P98),
    min: NSW_MIN,
    max: NSW_P98,
    clamped: true,
    label: "Median house price",
    format: fmtPriceShort,
    showNoData: true,
    noDataLabel: "No price data",
  },
};
