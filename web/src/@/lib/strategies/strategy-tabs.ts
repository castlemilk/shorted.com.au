// The profile tabs of /strategies/[strategy]. Serialisable (no React, no
// functions in data), so the layout, the client tab bar and the tests all read
// the same list.
//
// A tab is listed here before its page ships, with `enabled: false`: the tab
// bar renders only enabled tabs, so a tab appears in the UI in the same change
// that adds its route. Overview is the canonical strategy URL.
export type StrategyTabId =
  | "overview"
  | "rules"
  | "backtest"
  | "signals"
  | "trades";

export interface StrategyTab {
  id: StrategyTabId;
  label: string;
  /** URL segment under /strategies/{slug}; "" for the overview. */
  segment: string;
  /** Rendered by the tab bar and linked to. False until the tab's page ships. */
  enabled: boolean;
}

export const STRATEGY_TABS: readonly StrategyTab[] = [
  { id: "overview", label: "Overview", segment: "", enabled: true },
  { id: "rules", label: "Rules", segment: "rules", enabled: true },
  { id: "backtest", label: "Backtest", segment: "backtest", enabled: false },
  { id: "signals", label: "Signals", segment: "signals", enabled: true },
  { id: "trades", label: "Trades", segment: "trades", enabled: false },
];

/** The tabs the tab bar renders, in display order. */
export function enabledStrategyTabs(): readonly StrategyTab[] {
  return STRATEGY_TABS.filter((tab) => tab.enabled);
}

export function strategyTabHref(slug: string, id: StrategyTabId): string {
  const tab = STRATEGY_TABS.find((t) => t.id === id);
  return tab?.segment
    ? `/strategies/${slug}/${tab.segment}`
    : `/strategies/${slug}`;
}

/**
 * The tab a pathname is on: the first segment after /strategies/{slug}, else
 * overview. A segment no tab owns is overview too, never an error.
 */
export function activeStrategyTab(pathname: string): StrategyTabId {
  const m = /^\/strategies\/[^/]+(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m?.[1]) return "overview";
  const tab = STRATEGY_TABS.find((t) => t.segment === m[1]);
  return tab ? tab.id : "overview";
}

export function strategyTabLabel(id: StrategyTabId): string {
  return STRATEGY_TABS.find((t) => t.id === id)?.label ?? "Overview";
}
