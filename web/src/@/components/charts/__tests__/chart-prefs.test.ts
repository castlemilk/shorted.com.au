import { act, renderHook } from "@testing-library/react";
import {
  resetChartPrefsForTests,
  useChartPrefs,
  type ChartPrefs,
} from "../chart-prefs";

const DEFAULTS: ChartPrefs = {
  period: "1y",
  view: "combined",
  showMA: false,
  showDivergence: false,
};

/** One mount of the hook, as one panel would make it. */
function mount(
  stockCode: string,
  prefsKey?: string,
  defaults: ChartPrefs = DEFAULTS,
) {
  return renderHook(() => useChartPrefs({ stockCode, prefsKey, defaults }));
}

beforeEach(() => {
  resetChartPrefsForTests();
});

describe("useChartPrefs", () => {
  it("starts from the defaults when nothing has been chosen", () => {
    const keyed = mount("BHP", "BHP:overview");
    expect(keyed.result.current[0]).toEqual(DEFAULTS);

    const unkeyed = mount("BHP");
    expect(unkeyed.result.current[0]).toEqual(DEFAULTS);
  });

  it("changes what it returns when a choice is made, and merges the patch", () => {
    const { result } = mount("BHP", "BHP:overview");

    act(() => result.current[1]({ view: "price" }));
    act(() => result.current[1]({ showMA: true }));

    // The first patch is still there after the second.
    expect(result.current[0]).toEqual({ ...DEFAULTS, view: "price", showMA: true });
  });

  it("shares the period between two keys of the same stock", () => {
    const overview = mount("BHP", "BHP:overview");
    act(() => overview.result.current[1]({ period: "6m" }));

    // Another tab's panel mounts later, under its own key, and finds the period.
    const shortInterest = mount("BHP", "BHP:short-interest");
    expect(shortInterest.result.current[0].period).toBe("6m");
  });

  it("keeps the period per stock, not for every stock", () => {
    const bhp = mount("BHP", "BHP:overview");
    act(() => bhp.result.current[1]({ period: "6m" }));

    const cba = mount("CBA", "CBA:overview");
    expect(cba.result.current[0].period).toBe("1y");
  });

  it("takes the stock code in either case for the shared period", () => {
    const upper = mount("BHP", "BHP:overview");
    act(() => upper.result.current[1]({ period: "3m" }));

    const lower = mount("bhp", "bhp:short-interest");
    expect(lower.result.current[0].period).toBe("3m");
  });

  it("keeps the view, SMA 20 and divergence per key", () => {
    const overview = mount("BHP", "BHP:overview");
    act(() =>
      overview.result.current[1]({
        view: "price",
        showMA: true,
        showDivergence: true,
      }),
    );

    // Short interest opens on its own default, as if Overview had not been used.
    const shortInterest = mount("BHP", "BHP:short-interest", {
      ...DEFAULTS,
      view: "short",
    });
    expect(shortInterest.result.current[0]).toEqual({
      period: "1y",
      view: "short",
      showMA: false,
      showDivergence: false,
    });

    // And Overview, mounted again, has what it was left with.
    const overviewAgain = mount("BHP", "BHP:overview");
    expect(overviewAgain.result.current[0]).toEqual({
      period: "1y",
      view: "price",
      showMA: true,
      showDivergence: true,
    });
  });

  it("restores the choices when the panel is unmounted and mounted again", () => {
    const first = mount("BHP", "BHP:overview");
    act(() => first.result.current[1]({ period: "6m", view: "short" }));
    first.unmount();

    const second = mount("BHP", "BHP:overview");
    expect(second.result.current[0]).toMatchObject({ period: "6m", view: "short" });
  });

  it("lets a choice of false stand over a default of true", () => {
    const on: ChartPrefs = { ...DEFAULTS, showMA: true };
    const first = mount("BHP", "BHP:overview", on);
    act(() => first.result.current[1]({ showMA: false }));
    first.unmount();

    expect(mount("BHP", "BHP:overview", on).result.current[0].showMA).toBe(false);
  });

  it("stores nothing without a key, the period included", () => {
    const unkeyed = mount("BHP");
    act(() => unkeyed.result.current[1]({ period: "6m", view: "price", showMA: true }));
    // It is local state: the panel itself changes...
    expect(unkeyed.result.current[0]).toMatchObject({
      period: "6m",
      view: "price",
      showMA: true,
    });
    unkeyed.unmount();

    // ...but a mount that comes after, keyed or not, finds nothing.
    expect(mount("BHP").result.current[0]).toEqual(DEFAULTS);
    expect(mount("BHP", "BHP:overview").result.current[0]).toEqual(DEFAULTS);
  });

  it("forgets every choice on the reset", () => {
    const first = mount("BHP", "BHP:overview");
    act(() => first.result.current[1]({ period: "6m", view: "price", showDivergence: true }));
    first.unmount();

    resetChartPrefsForTests();

    expect(mount("BHP", "BHP:overview").result.current[0]).toEqual(DEFAULTS);
    expect(mount("BHP", "BHP:short-interest").result.current[0]).toEqual(DEFAULTS);
  });
});
