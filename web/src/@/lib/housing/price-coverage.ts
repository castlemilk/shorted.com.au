/**
 * Why a suburb has no official median price series — per state, because the
 * reason is a property of the state's data, not of the suburb. The profile used
 * to say "No median price series … yet" everywhere, which promised a series
 * that, for five states, is not coming (docs/feature/housing/data-sources.md).
 */

/** Valuer-General suburb medians we ingest (NSW PSI, VIC VPSR, SA CKAN). */
const VG_PRICED_STATES = new Set(["NSW", "VIC", "SA"]);

/** States that sell their sales records through licensed brokers. */
const COMMERCIALLY_LICENSED_STATES = new Set(["QLD", "WA"]);

export type PriceGap = { headline: string; detail: string };

export function priceSeriesGap(stateCode: string, stateName: string, suburbName: string): PriceGap {
  if (VG_PRICED_STATES.has(stateCode)) {
    return {
      headline: `No Valuer-General median for ${suburbName}.`,
      detail: `${stateName}'s Valuer-General data is open, but a median needs enough settled house sales in one period, and ${suburbName} does not have them.`,
    };
  }
  if (COMMERCIALLY_LICENSED_STATES.has(stateCode)) {
    return {
      headline: `No open median house price for ${suburbName}.`,
      detail: `${stateName} sells its property sales records through licensed brokers rather than publishing them openly, so there is no official suburb median we can show.`,
    };
  }
  return {
    headline: `No open median house price for ${suburbName}.`,
    detail: `${stateName} publishes no open Valuer-General sales feed, so there is no official suburb median we can show.`,
  };
}
