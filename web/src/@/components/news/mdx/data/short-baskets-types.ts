/** Shared shape for a pre-baked short-position basket (see bake-short-basket.ts). */
export interface BasketDef {
  /** Stable basket key, e.g. "banks" | "lithium" | "ironore". */
  key: string;
  /** Human label for the chart header. */
  label: string;
  /** ISO date (YYYY-MM-DD) of the latest weekly reading. */
  asOf: string;
  /** Member ASX codes, stack order bottom→top (largest first). */
  codes: readonly string[];
  /** Shared weekly spine, epoch ms, ascending. */
  dates: number[];
  /** code → short interest percent of issue, per date. */
  pct: Record<string, number[]>;
  /** code → short value in AUD billions (shares × close), per date. */
  dollar: Record<string, number[]>;
  /** Peak summed-dollar basket across the spine (the "record"). */
  recordValueBn: number;
  /** Epoch ms of the record point. */
  recordDate: number;
}
