"use client";

import { ShortBasketChart, type Mode, type Win } from "./short-basket-core";
import { BASKETS } from "./data/short-baskets";

/**
 * Generic sector short-position basket, selected by registry key (banks,
 * lithium, ironore, …). The newsroom emits this for multi-stock/sector takes;
 * the data is pre-baked (see data/short-baskets.ts + bake-short-basket.ts).
 */
export function ShortBasket({
  basket = "banks",
  window: win = "1y",
  mode = "dollar",
  title,
}: {
  basket?: string;
  window?: Win;
  mode?: Mode;
  title?: string;
}) {
  const def = BASKETS[basket];
  if (!def) return null;
  return <ShortBasketChart def={def} window={win} mode={mode} title={title} />;
}
