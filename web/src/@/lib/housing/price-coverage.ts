/**
 * Why a suburb has no official median price series — per state, because the
 * reason is a property of the state's data, not of the suburb. The profile used
 * to say "No median price series … yet" everywhere, which promised a series
 * that, for five states, is not coming (docs/feature/housing/data-sources.md).
 *
 * Missing data can reflect source coverage, sales thresholds or an unresolved
 * suburb match. Population does not establish which reason applies.
 */

/** Valuer-General suburb medians we ingest from whole-state feeds (NSW PSI, VIC VPSR). */
const VG_PRICED_STATES = new Set(["NSW", "VIC"]);

/** States that sell their sales records through licensed brokers. */
const COMMERCIALLY_LICENSED_STATES = new Set(["QLD", "WA"]);

export type PriceGap = { headline: string; detail: string };

export function priceSeriesGap(
  stateCode: string,
  stateName: string,
  suburbName: string,
): PriceGap {
  if (stateCode === "SA") {
    return {
      headline: `No Valuer-General median for ${suburbName}.`,
      detail: `South Australia's open Valuer-General suburb median feed covers metropolitan Adelaide only. We have no median for ${suburbName} from this feed.`,
    };
  }
  if (VG_PRICED_STATES.has(stateCode)) {
    return {
      headline: `No Valuer-General median for ${suburbName}.`,
      detail: `${stateName}'s Valuer-General sales data is open, but we have no suburb median for ${suburbName} from it.`,
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
