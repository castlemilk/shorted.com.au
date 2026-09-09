/**
 * Visual coverage for the hazard round: the three new colour ramps (water,
 * fire, terrain) sampled through MapLegend exactly as the map paints them, and
 * the overlay legend chips. Same reasoning as map-legend.stories.tsx — the
 * legend is the cheap place to screenshot a colour scale.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { MapLegend } from "./map-legend";
import { OverlayLegend } from "./overlay-control";
import { fireScale, terrainScale, waterScale } from "~/@/lib/housing/highlight-metrics";

const meta = {
  title: "Housing/HazardLegends",
  component: MapLegend,
  parameters: { layout: "centered" },
} satisfies Meta<typeof MapLegend>;

export default meta;
type Story = StoryObj<typeof meta>;

const pct = (v: number) => `${Math.round(v)}%`;

/** Observed surface water share, 0–25% domain (the tail above 25% clamps). */
export const WaterObserved: Story = {
  args: {
    colorScale: waterScale(0, 25), min: 0, max: 25, clamped: true,
    label: "Land observed under water since 1987", format: (v) => `${v.toFixed(0)}%`,
    noDataLabel: "Not observed",
  },
};

/** Flood planning area share on the full 0–100 range. */
export const FloodPlanning: Story = {
  args: {
    colorScale: waterScale(0, 100), min: 0, max: 100,
    label: "Land in a flood planning area", format: pct, noDataLabel: "No statutory layer",
  },
};

/** Bushfire prone share — warm ramp, never the price amber. */
export const BushfireProne: Story = {
  args: {
    colorScale: fireScale(0, 100), min: 0, max: 100,
    label: "Land designated bushfire prone", format: pct, noDataLabel: "No statutory layer",
  },
};

/** Hypsometric elevation ramp over NSW's measured range (p98 ≈ 1,000 m). */
export const Elevation: Story = {
  args: {
    colorScale: terrainScale(0, 1000), min: 0, max: 1000, clamped: true,
    label: "Median elevation (m above sea level)", format: (v) => `${Math.round(v)} m`,
  },
};

/** The overlay chips stacked beneath a colour legend, as on /housing/nsw. */
export const OverlayChips: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-1.5">
      <MapLegend
        colorScale={waterScale(0, 25)} min={0} max={25} clamped
        label="Land observed under water since 1987" format={(v) => `${v.toFixed(0)}%`}
        noDataLabel="Not observed"
      />
      <OverlayLegend stateCode="NSW" active={["flood_planning", "water_observed", "bushfire_prone"]} />
    </div>
  ),
};
