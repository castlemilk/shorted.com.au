"use client";

/**
 * What the visitor chose on the chart panel, kept for as long as the page
 * lives (spec D4, "Settings survive a tab switch").
 *
 * Each chart tab mounts its own panel, so without a store the visitor who picks
 * 6M on Overview, reads Financials and comes back finds 1Y again. This module
 * outlives the panel: it survives soft navigation and goes with a reload
 * (nothing is written to storage).
 *
 * Two scopes, because the tabs agree about some choices and not others:
 * - the PERIOD is per stock, under `period:<STOCKCODE>`, and both chart tabs
 *   share it: 6M means the same on Overview and on Short interest;
 * - the VIEW, SMA 20 and divergence are per `prefsKey` (`"BHP:overview"`), so
 *   each tab keeps its own default view. Short interest opens on the short
 *   series, and a visitor who picked Price & Volume on Overview has not asked
 *   for that there.
 *
 * With no `prefsKey` the panel is plain local state and nothing is stored, the
 * period included: the dashboard and the stories take no part in this.
 */
import { useCallback, useState } from "react";
import type { ChartPeriod, ChartViewId } from "./chart-views";

export interface ChartPrefs {
  period: ChartPeriod;
  view: ChartViewId;
  showMA: boolean;
  showDivergence: boolean;
}

export interface UseChartPrefsOptions {
  stockCode: string;
  /** Where the view, SMA 20 and divergence are kept. Omitted: nothing is kept. */
  prefsKey?: string;
  /** What each choice is until the visitor makes it. */
  defaults: ChartPrefs;
}

// Module level, so it outlives any panel. Holds only what the visitor chose:
// a choice they have not made is absent, and a read falls back to the default.
const store = new Map<string, Partial<ChartPrefs>>();

const periodKey = (stockCode: string) => `period:${stockCode.toUpperCase()}`;

function readPrefs(
  stockCode: string,
  prefsKey: string | undefined,
  defaults: ChartPrefs,
): ChartPrefs {
  if (!prefsKey) return { ...defaults };
  const mine = store.get(prefsKey);
  const shared = store.get(periodKey(stockCode));
  return {
    period: shared?.period ?? defaults.period,
    view: mine?.view ?? defaults.view,
    showMA: mine?.showMA ?? defaults.showMA,
    showDivergence: mine?.showDivergence ?? defaults.showDivergence,
  };
}

function writePrefs(
  stockCode: string,
  prefsKey: string | undefined,
  patch: Partial<ChartPrefs>,
): void {
  if (!prefsKey) return;
  const { period, ...mine } = patch;
  if (period !== undefined) store.set(periodKey(stockCode), { period });
  if (Object.keys(mine).length > 0) {
    store.set(prefsKey, { ...store.get(prefsKey), ...mine });
  }
}

/** What the hook holds, and the stock and key it was read for. */
interface Held {
  stockCode: string;
  prefsKey: string | undefined;
  prefs: ChartPrefs;
}

/**
 * The panel's choices and a setter that merges a patch into them. They start
 * from the store on the first render (the panel is client-only, so there is no
 * server render to disagree with) and every change is written through, so a
 * panel that mounts later, on another tab, starts where this one left off.
 *
 * A panel handed another stock or key reads the store again for it, in that
 * same render: the stock page remounts its panel between stocks anyway (a
 * dynamic segment is keyed by its param), but a panel that is not remounted
 * must not carry one stock's period over to the next, nor ask for the next
 * stock's data in it. With no key there is nothing to read, and the panel
 * keeps the choices it has.
 */
export function useChartPrefs({
  stockCode,
  prefsKey,
  defaults,
}: UseChartPrefsOptions): [ChartPrefs, (patch: Partial<ChartPrefs>) => void] {
  const [held, setHeld] = useState<Held>(() => ({
    stockCode,
    prefsKey,
    prefs: readPrefs(stockCode, prefsKey, defaults),
  }));

  // React's "adjust state while rendering": it throws this pass away and
  // renders again with the new state before anything is committed, so no pass
  // ever pairs the new stock with the old one's period.
  let current = held;
  if (held.stockCode !== stockCode || held.prefsKey !== prefsKey) {
    current = {
      stockCode,
      prefsKey,
      prefs: prefsKey ? readPrefs(stockCode, prefsKey, defaults) : held.prefs,
    };
    setHeld(current);
  }

  const setPrefs = useCallback(
    (patch: Partial<ChartPrefs>) => {
      writePrefs(stockCode, prefsKey, patch);
      setHeld((prev) => ({ ...prev, prefs: { ...prev.prefs, ...patch } }));
    },
    [stockCode, prefsKey],
  );
  return [current.prefs, setPrefs];
}

/** Forgets every choice. For tests and stories: the store outlives a mount. */
export function resetChartPrefsForTests(): void {
  store.clear();
}
