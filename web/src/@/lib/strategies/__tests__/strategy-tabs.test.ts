import {
  STRATEGY_TABS,
  activeStrategyTab,
  enabledStrategyTabs,
  strategyTabHref,
  strategyTabLabel,
} from "~/@/lib/strategies/strategy-tabs";
import { STRATEGY_SLUGS } from "~/@/lib/strategies/registry";

describe("strategy profile tabs", () => {
  it("lists the five tabs in the profile's order, Overview first", () => {
    expect(STRATEGY_TABS.map((tab) => tab.id)).toEqual([
      "overview",
      "rules",
      "backtest",
      "signals",
      "trades",
    ]);
  });

  it("renders the tabs whose pages ship: the Overview, Rules, Backtest, Signals and Trades", () => {
    expect(enabledStrategyTabs().map((tab) => tab.id)).toEqual([
      "overview",
      "rules",
      "backtest",
      "signals",
      "trades",
    ]);
  });

  it("gives every tab a unique segment, Overview none", () => {
    const segments = STRATEGY_TABS.map((tab) => tab.segment);
    expect(segments[0]).toBe("");
    expect(new Set(segments).size).toBe(segments.length);
  });

  it("links the Overview to the canonical strategy URL and the others under it", () => {
    expect(strategyTabHref("canslim", "overview")).toBe("/strategies/canslim");
    expect(strategyTabHref("canslim", "signals")).toBe(
      "/strategies/canslim/signals",
    );
    expect(strategyTabHref("canslim", "rules")).toBe(
      "/strategies/canslim/rules",
    );
  });

  it("finds the active tab from the pathname, Overview for the bare strategy URL", () => {
    expect(activeStrategyTab("/strategies/canslim")).toBe("overview");
    expect(activeStrategyTab("/strategies/canslim/")).toBe("overview");
    expect(activeStrategyTab("/strategies/canslim/signals")).toBe("signals");
    expect(activeStrategyTab("/strategies/canslim/trades")).toBe("trades");
  });

  it("falls back to Overview for a segment no tab owns, and off the strategy routes", () => {
    expect(activeStrategyTab("/strategies/canslim/unknown")).toBe("overview");
    expect(activeStrategyTab("/strategies")).toBe("overview");
    expect(activeStrategyTab("/strategies/canslim/signals/extra")).toBe(
      "overview",
    );
  });

  it("labels every tab", () => {
    expect(strategyTabLabel("overview")).toBe("Overview");
    expect(strategyTabLabel("backtest")).toBe("Backtest");
  });

  it("builds each tab's href under its strategy's own URL and reads the tab back from it", () => {
    for (const slug of STRATEGY_SLUGS) {
      for (const tab of STRATEGY_TABS) {
        const href = strategyTabHref(slug, tab.id);
        expect(href.startsWith(`/strategies/${slug}`)).toBe(true);
        expect(activeStrategyTab(href)).toBe(tab.id);
      }
    }
  });
});
