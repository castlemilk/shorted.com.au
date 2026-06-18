"use client";

import { useMemo } from "react";
import { ShortBasketChart, type Mode, type Win } from "./short-basket-core";
import { BASKETS } from "./data/short-baskets";
import type { BasketDef } from "./data/short-baskets-types";

/**
 * The big-four banks short basket. Thin wrapper over the generic
 * ShortBasketChart that honours the legacy `banks` prop (a subset/ordering of
 * the banks basket). New sector baskets use <ShortBasket basket="…" /> instead.
 */
export function BankShortBasket({
  banks = "CBA,WBC,NAB,ANZ",
  window: win = "1y",
  mode = "dollar",
  title = "Big four bank short positions",
}: {
  banks?: string;
  window?: Win;
  mode?: Mode;
  title?: string;
}) {
  const def = useMemo<BasketDef>(() => {
    const base = BASKETS.banks!;
    const requested = new Set(banks.split(",").map((c) => c.trim().toUpperCase()));
    const codes = base.codes.filter((c) => requested.has(c));
    return codes.length === base.codes.length ? base : { ...base, codes };
  }, [banks]);

  return <ShortBasketChart def={def} window={win} mode={mode} title={title} />;
}
