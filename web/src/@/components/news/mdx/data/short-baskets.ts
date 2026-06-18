/**
 * Registry of pre-baked short-position baskets. New sectors: run
 * `scripts/take-writer/src/bake-short-basket.ts --key=… --codes=…` then add the
 * import here. The banks basket is adapted from the original bank-basket bake.
 */
import type { BasketDef } from "./short-baskets-types";
import { BANK_BASKET_SERIES, BASKET_RECORD } from "./bank-basket-series";
import { BASKET as lithium } from "./short-basket-lithium";
import { BASKET as ironore } from "./short-basket-ironore";

const banks: BasketDef = {
  key: "banks",
  label: "Big four banks",
  asOf: BANK_BASKET_SERIES.asOf,
  codes: BANK_BASKET_SERIES.codes,
  dates: BANK_BASKET_SERIES.dates,
  pct: BANK_BASKET_SERIES.pct,
  dollar: BANK_BASKET_SERIES.dollar,
  recordValueBn: BASKET_RECORD.valueBn,
  recordDate: BASKET_RECORD.date,
};

export const BASKETS: Record<string, BasketDef> = { banks, lithium, ironore };
export const BASKET_KEYS = Object.keys(BASKETS);

export type { BasketDef };
