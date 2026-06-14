import {
  calculateAdvancedIndicator,
  calculateSMA,
  calculateEMA,
  isOscillator,
  normalizeToPercentChange,
  INDICATOR_METADATA,
  type IndicatorConfig,
  type IndicatorResult,
} from "@/lib/technical-indicators";

export {
  calculateAdvancedIndicator,
  calculateSMA,
  calculateEMA,
  isOscillator,
  normalizeToPercentChange,
  INDICATOR_METADATA,
};
export type { IndicatorConfig, IndicatorResult };

/**
 * Compute an indicator from a series' raw values. `result.values` is index-aligned
 * to `values`, so the core can subsample it with the series by the LTTB indices.
 */
export function buildIndicator(
  values: number[],
  config: IndicatorConfig,
): IndicatorResult {
  return calculateAdvancedIndicator(values, config);
}
