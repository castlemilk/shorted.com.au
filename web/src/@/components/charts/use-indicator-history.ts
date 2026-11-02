"use client";

import { useMemo, useState } from "react";
import { useHistoricalData, useShortTimeSeries } from "@/hooks/use-stock-queries";
import { historicalToPoints, shortSeriesToPoints } from "./adapters";
import {
  CHART_INDICATORS,
  PRICE_SESSIONS,
  SHORT_DAYS,
  coversLookback,
  heldCovers,
  indicatorDef,
  planWarmup,
  type ChartIndicatorId,
  type IndicatorTarget,
} from "./chart-indicators";
import type { ChartPeriod } from "./chart-views";
import type { ChartPoint } from "./types";

export interface IndicatorHistory {
  /**
   * The earlier price points the price indicators compute from: the longest loaded for
   * this stock. Undefined when that is the visible series, which has no points before
   * its first one.
   */
  price?: ChartPoint[];
  /** The earlier short-interest points, likewise. */
  short?: ChartPoint[];
  /** Some selected price indicator is still waiting for its history. */
  pricePending: boolean;
  /** Some selected short-interest indicator is still waiting for its history. */
  shortPending: boolean;
  /**
   * The selected indicators still waiting for their history, in registry order.
   * Each one is held back until its history lands. An indicator that needs no
   * earlier history here is never in this list.
   */
  waiting: readonly ChartIndicatorId[];
}

/** A loaded history, and the period it was loaded for. */
interface Held {
  period: ChartPeriod;
  points: ChartPoint[];
}

interface Kept {
  code: string;
  price?: Held;
  short?: Held;
}

/** How far back a period reaches, in the unit its target's history is kept in. */
function spanOf(target: IndicatorTarget, period: ChartPeriod): number {
  if (target === "price") return PRICE_SESSIONS[period];
  return period === "max" ? Number.POSITIVE_INFINITY : SHORT_DAYS[period];
}

/**
 * The longer of a held history and a freshly loaded one: the one that reaches
 * further back, and the newer one when the two reach equally far.
 */
function longerHeld(
  target: IndicatorTarget,
  held: Held | undefined,
  fresh: Held | undefined,
): Held | undefined {
  if (!fresh?.points.length) return held;
  if (!held?.points.length) return fresh;
  return spanOf(target, fresh.period) >= spanOf(target, held.period) ? fresh : held;
}

/**
 * The earlier history the chosen indicators compute from, and which of them still
 * wait for it.
 *
 * The history loaded for a stock is kept across periods: a longer one serves a
 * shorter period too, since a computation only takes the points before its first
 * visible one. The visible series is kept as well, so a period the visitor has already
 * viewed serves a shorter one with no request. So an indicator that is turned off does
 * not take away the history the others use, and a period whose history is already held
 * asks for nothing more. The warm-up is planned only for the indicators that held
 * history does not cover.
 *
 * An indicator waits only while it needs history that is not held and that history is
 * loading. Once it lands, or the load ends without it, the indicator is drawn from what
 * there is. The hook reads the same query keys as the period buttons, so a period the
 * visitor has seen costs nothing.
 */
export function useIndicatorHistory(
  code: string,
  period: ChartPeriod,
  ids: readonly ChartIndicatorId[],
): IndicatorHistory {
  // The visible series, through the queries the chart panel reads: no request is added.
  const visiblePriceQ = useHistoricalData(code, period);
  const visibleShortQ = useShortTimeSeries(code, period);
  const visiblePrice = useMemo(
    () => historicalToPoints(visiblePriceQ.data).price,
    [visiblePriceQ.data],
  );
  const visibleShort = useMemo(
    () => shortSeriesToPoints(visibleShortQ.data),
    [visibleShortQ.data],
  );
  // The visible series is held history too, so a period the visitor has already viewed
  // serves a shorter one with no request. Short interest on MAX is weekly buckets and is
  // never held. Memoized, so a held value keeps its identity from one render to the next.
  const visiblePriceHeld = useMemo<Held | undefined>(
    () => (visiblePrice.length ? { period, points: visiblePrice } : undefined),
    [period, visiblePrice],
  );
  const visibleShortHeld = useMemo<Held | undefined>(
    () =>
      period !== "max" && visibleShort.length
        ? { period, points: visibleShort }
        : undefined,
    [period, visibleShort],
  );

  // What is kept for this stock. It is read during render and set when a longer
  // history lands, so the value used is never a render behind. A new stock starts
  // again.
  const [kept, setKept] = useState<Kept>({ code });
  const current: Kept = kept.code === code ? kept : { code };
  const heldPricePeriod = current.price?.period;
  const heldShortPeriod = current.short?.period;

  // The indicators the held history does not cover: the only ones a warm-up is for.
  // A 1Y chart with SMA 50 loads 2Y once; a 3M chart after it loads nothing more.
  const needy = useMemo(
    () =>
      ids.filter((id) => {
        const def = indicatorDef(id);
        const held = def.target === "price" ? heldPricePeriod : heldShortPeriod;
        return !heldCovers(def, held, period);
      }),
    [ids, period, heldPricePeriod, heldShortPeriod],
  );
  const plan = useMemo(() => planWarmup(period, needy), [period, needy]);

  // The warm-up queries. A disabled one reads nothing, and a plan with no warm-up
  // makes no request.
  const warmPriceQ = useHistoricalData(code, plan.price ?? period, {
    enabled: plan.price !== null,
  });
  const warmShortQ = useShortTimeSeries(code, plan.short ?? period, {
    enabled: plan.short !== null,
  });
  const freshPrice = useMemo<Held | undefined>(
    () =>
      plan.price
        ? { period: plan.price, points: historicalToPoints(warmPriceQ.data).price }
        : undefined,
    [plan.price, warmPriceQ.data],
  );
  const freshShort = useMemo<Held | undefined>(
    () =>
      plan.short
        ? { period: plan.short, points: shortSeriesToPoints(warmShortQ.data) }
        : undefined,
    [plan.short, warmShortQ.data],
  );

  const priceHeld = longerHeld(
    "price",
    longerHeld("price", current.price, visiblePriceHeld),
    freshPrice,
  );
  const shortHeld = longerHeld(
    "short",
    longerHeld("short", current.short, visibleShortHeld),
    freshShort,
  );
  if (
    current !== kept ||
    priceHeld !== current.price ||
    shortHeld !== current.short
  ) {
    setKept({ code, price: priceHeld, short: shortHeld });
  }

  // A disabled TanStack v5 query is pending, so each flag is gated on the plan.
  const loadingPrice = plan.price !== null && warmPriceQ.isPending;
  const loadingShort = plan.short !== null && warmShortQ.isPending;
  const waiting = useMemo(() => {
    const out: ChartIndicatorId[] = [];
    for (const def of CHART_INDICATORS) {
      if (!needy.includes(def.id)) continue;
      const firstVisible =
        def.target === "price" ? visiblePrice[0]?.t : visibleShort[0]?.t;
      // Nothing visible to compute on yet, or the indicator needs no earlier history here.
      if (firstVisible === undefined) continue;
      if (planWarmup(period, [def.id])[def.target] === null) continue;
      const available =
        def.target === "price" ? priceHeld?.points : shortHeld?.points;
      if (coversLookback(def, available, firstVisible)) continue;
      if (def.target === "price" ? loadingPrice : loadingShort) out.push(def.id);
    }
    return out;
  }, [
    needy,
    period,
    visiblePrice,
    visibleShort,
    priceHeld,
    shortHeld,
    loadingPrice,
    loadingShort,
  ]);

  // The earlier history the indicators compute from. The visible series has none before
  // its own first point, so it is not returned; and short interest on MAX takes no daily
  // history, since its points are weekly buckets.
  const earlierPrice =
    priceHeld !== visiblePriceHeld ? priceHeld?.points : undefined;
  const earlierShort =
    period !== "max" && shortHeld !== visibleShortHeld
      ? shortHeld?.points
      : undefined;
  return {
    price: earlierPrice,
    short: earlierShort,
    pricePending: waiting.some((id) => indicatorDef(id).target === "price"),
    shortPending: waiting.some((id) => indicatorDef(id).target === "short"),
    waiting,
  };
}
