import {
  STATE_NAMES,
  stateCorrelationCandidates,
  type StateSlug,
} from "@/lib/economy/map-metrics";
import { SeriesCorrelation } from "./series-correlation";

const SHORT_LABEL = "Local short interest";

/**
 * "Local short interest vs …" — correlates the state's exposure-weighted short
 * interest against its economic series. Renders rolling-Pearson chips (|r| ≥ 0.4,
 * ≥ 12 aligned months) and a dual-axis overlay with a secondary-series switcher.
 *
 * Descriptive only — the footnote states correlation ≠ causation. On a sparse
 * local short series (prod has ~138 months, dev ~5) the chips are correctly
 * absent; the overlay still renders whatever overlaps.
 */
export function StateCorrelations({ state }: { state: StateSlug }) {
  const name = STATE_NAMES[state];
  const shortKey = `markets.short_interest_wavg.${state}`;
  const exportsKey = `trade.export_value.total.${state}`;
  return (
    <SeriesCorrelation
      anchor={{ key: shortKey, label: SHORT_LABEL, format: "percent" }}
      overlayCandidates={stateCorrelationCandidates(state)}
      title={`Local short interest vs the ${name} economy`}
      description={`Exposure-weighted short interest across ASX companies operating in ${name}, overlaid on the state’s economic series.`}
      sectionAriaLabel={`${name} short interest correlations`}
      chartAriaLabel={`${name} local short interest versus`}
      defaultOverlayKey={exportsKey}
      precomputedBaseKey={shortKey}
    />
  );
}
