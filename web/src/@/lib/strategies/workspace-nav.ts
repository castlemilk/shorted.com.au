// The strategy workspace's sub-navigation: the tabs under the site header,
// over every /strategies route. Serialisable and free of React, so the layout's
// client island, the server pages and the tests all read the same list.
//
// A tab is listed before its page ships, with `enabled: false`: the bar renders
// only enabled tabs, so a tab appears in the same change that adds its route.
// Signals links to a strategy's signals page, resolved per visitor by
// resolveStrategiesTabs (never stored here).
import type { WorkspaceTab } from "~/@/components/workspace/workspace-sub-nav";
import { STRATEGY_SLUGS } from "~/@/lib/strategies/registry";
import { strategyTabHref } from "~/@/lib/strategies/strategy-tabs";

export type StrategiesTabId = "explore" | "my" | "signals" | "alerts";

export interface StrategiesTab extends WorkspaceTab<StrategiesTabId> {
  /** Rendered by the bar and linked to. False until the tab's route ships. */
  enabled: boolean;
}

/** The visible group name, shown on the bar's left. */
export const STRATEGIES_GROUP = "Strategies";

/**
 * The bar's accessible name. The strategy profile's own tab bar and the Signals
 * switcher are also named "Strategies", so the sub-nav takes a name of its own.
 */
export const STRATEGIES_LABEL = "Strategy workspace";

/** The strategy Signals opens when the visitor has not viewed one yet. */
export const DEFAULT_SIGNALS_STRATEGY = "crowded-short-breakout";

/** The localStorage key for the last strategy viewed (read and written in try/catch). */
export const LAST_VIEWED_STRATEGY_KEY = "shorted.strategies.lastViewed";

/**
 * First segments under /strategies that are not strategy slugs. The one list
 * the slug-collision test in registry.test.ts also reads: a strategy slug must
 * never equal one of these, or its profile would shadow the route.
 */
export const RESERVED_STRATEGY_SEGMENTS: readonly string[] = [
  "my",
  "alerts",
  "compare",
  "changelog",
  "signals",
  "new",
];

/**
 * The tabs in display order. `href` is the static target; Signals is resolved
 * per visitor by resolveStrategiesTabs. `enabled` follows the PR that ships each.
 */
export const STRATEGIES_TABS: readonly StrategiesTab[] = [
  { id: "explore", label: "Explore", href: "/strategies", enabled: true },
  { id: "my", label: "My strategies", href: "/strategies/my", enabled: false },
  {
    id: "signals",
    label: "Signals",
    href: strategyTabHref(DEFAULT_SIGNALS_STRATEGY, "signals"),
    enabled: true,
  },
  { id: "alerts", label: "Alerts", href: "/strategies/alerts", enabled: false },
];

/** The strategy slug a path is on, when the path is a strategy's own route (its profile or a tab of it). */
export function strategyFromPath(pathname: string): string | null {
  const m = /^\/strategies\/([^/]+)(?:\/|$)/.exec(pathname.replace(/\/+$/, "") || "/");
  const slug = m?.[1];
  if (!slug || RESERVED_STRATEGY_SEGMENTS.includes(slug)) return null;
  return slug;
}

/**
 * Whether a path is a strategy profile route. Its own tab bar is the sticky bar,
 * so the workspace sub-nav scrolls away above it.
 */
export function isStrategyProfilePath(pathname: string): boolean {
  return strategyFromPath(pathname) !== null;
}

/** The tab a pathname belongs to: alerts, my, a strategy's signals, else explore. */
export function activeStrategiesTab(pathname: string): StrategiesTabId {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/strategies/alerts" || path.startsWith("/strategies/alerts/")) return "alerts";
  if (path === "/strategies/my" || path.startsWith("/strategies/my/")) return "my";
  const m = /^\/strategies\/([^/]+)\/signals(?:\/|$)/.exec(path);
  if (m?.[1] && !RESERVED_STRATEGY_SEGMENTS.includes(m[1])) return "signals";
  return "explore";
}

/** A stored slug, when it names a strategy the registry knows; otherwise the default. */
export function signalsStrategy(stored: string | null): string {
  return stored !== null && STRATEGY_SLUGS.includes(stored) ? stored : DEFAULT_SIGNALS_STRATEGY;
}

/** The tabs the bar renders for one visitor, with Signals pointing at their strategy. */
export function resolveStrategiesTabs(lastViewed: string | null): WorkspaceTab<StrategiesTabId>[] {
  return STRATEGIES_TABS.filter((tab) => tab.enabled).map((tab) =>
    tab.id === "signals"
      ? { id: tab.id, label: tab.label, href: strategyTabHref(signalsStrategy(lastViewed), "signals") }
      : { id: tab.id, label: tab.label, href: tab.href },
  );
}

/** Reads the last strategy viewed. Storage can be blocked or throw, so any failure reads as none. */
export function readLastViewedStrategy(): string | null {
  try {
    return window.localStorage.getItem(LAST_VIEWED_STRATEGY_KEY);
  } catch {
    return null;
  }
}

/** Records the strategy being viewed. A failed write is dropped: the default still works. */
export function rememberStrategy(slug: string): void {
  try {
    window.localStorage.setItem(LAST_VIEWED_STRATEGY_KEY, slug);
  } catch {
    // Storage is unavailable (private mode, blocked site data): nothing to remember.
  }
}
