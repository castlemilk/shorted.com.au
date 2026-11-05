/// <reference types="jest" />

import {
  DEFAULT_SIGNALS_STRATEGY,
  LAST_VIEWED_STRATEGY_KEY,
  STRATEGIES_TABS,
  activeStrategiesTab,
  isStrategyProfilePath,
  readLastViewedStrategy,
  rememberStrategy,
  resolveStrategiesTabs,
  currentStrategiesTab,
  signalsStrategy,
  strategyFromPath,
} from "../workspace-nav";
import { STRATEGY_SLUGS } from "../registry";

describe("strategies workspace nav", () => {
  it("lists Explore, My strategies, Signals and Alerts, with Alerts alone disabled", () => {
    expect(STRATEGIES_TABS.map((tab) => [tab.id, tab.label, tab.enabled])).toEqual([
      ["explore", "Explore", true],
      ["my", "My strategies", true],
      ["signals", "Signals", true],
      ["alerts", "Alerts", false],
    ]);
  });

  it("renders only the enabled tabs, with Signals on the default strategy until one is viewed", () => {
    expect(resolveStrategiesTabs(null)).toEqual([
      { id: "explore", label: "Explore", href: "/strategies" },
      { id: "my", label: "My strategies", href: "/strategies/my" },
      { id: "signals", label: "Signals", href: `/strategies/${DEFAULT_SIGNALS_STRATEGY}/signals` },
    ]);
  });

  it("names the tab whose own page a path is, and null for a page under a section", () => {
    expect(currentStrategiesTab("/strategies")).toBe("explore");
    expect(currentStrategiesTab("/strategies/my")).toBe("my");
    expect(currentStrategiesTab("/strategies/alerts")).toBe("alerts");
    expect(currentStrategiesTab("/strategies/canslim/signals")).toBe("signals");
    expect(currentStrategiesTab("/strategies/canslim")).toBeNull();
    expect(currentStrategiesTab("/strategies/changelog")).toBeNull();
    expect(currentStrategiesTab("/strategies/signals/x/signals")).toBeNull();
  });

  it("points Signals at the last strategy viewed", () => {
    const tabs = resolveStrategiesTabs("canslim");
    expect(tabs.find((tab) => tab.id === "signals")?.href).toBe("/strategies/canslim/signals");
  });

  it("falls back to the default when the stored slug is not a strategy", () => {
    expect(STRATEGY_SLUGS).toContain(DEFAULT_SIGNALS_STRATEGY);
    expect(signalsStrategy("not-a-strategy")).toBe(DEFAULT_SIGNALS_STRATEGY);
    expect(signalsStrategy(null)).toBe(DEFAULT_SIGNALS_STRATEGY);
  });

  it("makes Explore active for the hub, the changelog and a strategy's own profile", () => {
    expect(activeStrategiesTab("/strategies")).toBe("explore");
    expect(activeStrategiesTab("/strategies/")).toBe("explore");
    expect(activeStrategiesTab("/strategies/changelog")).toBe("explore");
    expect(activeStrategiesTab("/strategies/canslim")).toBe("explore");
    expect(activeStrategiesTab("/strategies/canslim/rules")).toBe("explore");
  });

  it("makes Signals active for a strategy's signals page, and nothing else", () => {
    expect(activeStrategiesTab("/strategies/crowded-short-breakout/signals")).toBe("signals");
    expect(activeStrategiesTab("/strategies/canslim/signals/")).toBe("signals");
  });

  it("makes My strategies and Alerts active on their own routes", () => {
    expect(activeStrategiesTab("/strategies/my")).toBe("my");
    expect(activeStrategiesTab("/strategies/my/variants")).toBe("my");
    expect(activeStrategiesTab("/strategies/alerts")).toBe("alerts");
    expect(activeStrategiesTab("/strategies/alerts/new")).toBe("alerts");
  });

  it("reads the strategy a path is on, and never a reserved segment", () => {
    expect(strategyFromPath("/strategies/canslim")).toBe("canslim");
    expect(strategyFromPath("/strategies/canslim/signals")).toBe("canslim");
    expect(strategyFromPath("/strategies")).toBeNull();
    expect(strategyFromPath("/strategies/changelog")).toBeNull();
    expect(strategyFromPath("/strategies/my")).toBeNull();
    expect(strategyFromPath("/strategies/alerts/new")).toBeNull();
    expect(strategyFromPath("/ownership/funds")).toBeNull();
  });

  it("treats a strategy's own routes as profile routes, whose tab bar keeps the sticky place", () => {
    expect(isStrategyProfilePath("/strategies/canslim")).toBe(true);
    expect(isStrategyProfilePath("/strategies/canslim/signals")).toBe(true);
    expect(isStrategyProfilePath("/strategies")).toBe(false);
    expect(isStrategyProfilePath("/strategies/alerts")).toBe(false);
  });
});

describe("the last viewed strategy's storage", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  it("remembers the strategy and reads it back", () => {
    rememberStrategy("zanger-breakout");
    expect(window.localStorage.getItem(LAST_VIEWED_STRATEGY_KEY)).toBe("zanger-breakout");
    expect(readLastViewedStrategy()).toBe("zanger-breakout");
  });

  it("reads none when nothing is stored", () => {
    expect(readLastViewedStrategy()).toBeNull();
  });

  it("drops a write and reads none when storage throws", () => {
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => rememberStrategy("canslim")).not.toThrow();
    expect(readLastViewedStrategy()).toBeNull();
  });
});
