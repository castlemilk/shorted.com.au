import {
  GLOBAL_ECONOMY_SERIES,
  GLOBAL_SERIES_GROUPS,
  GLOBAL_GROUP_TITLES,
  globalSeriesInGroup,
} from "@/lib/economy/global-series";
import {
  ECONOMY_SERIES_FORMATTERS,
  NATIONAL_ECONOMY_OVERLAYS,
} from "@/lib/economy/map-metrics";

describe("global economy series registry", () => {
  // Two entries under one key would render the same chart twice and offer the
  // same overlay twice, with React keying on the duplicate.
  it("has unique series keys", () => {
    const keys = GLOBAL_ECONOMY_SERIES.map((series) => series.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The /economy page renders one section per group and drops empty ones. A
  // group declared with no members is a heading nobody will ever see, and a
  // member in an undeclared group is a chart that renders nowhere.
  it("declares exactly the groups its members use", () => {
    const declared = GLOBAL_SERIES_GROUPS.map(({ group }) => group);
    expect(new Set(declared).size).toBe(declared.length);
    for (const group of declared) {
      expect(globalSeriesInGroup(group).length).toBeGreaterThan(0);
    }
    for (const series of GLOBAL_ECONOMY_SERIES) {
      expect(declared).toContain(series.group);
    }
  });

  // A format with no formatter throws at render time inside a dynamic,
  // ssr:false chart — which surfaces as a blank card, not an error page.
  it("only uses formats that have a formatter", () => {
    for (const series of GLOBAL_ECONOMY_SERIES) {
      expect(typeof ECONOMY_SERIES_FORMATTERS[series.format]).toBe("function");
    }
  });

  // The picker sits beside Australian indicators. An unlabelled "10-year
  // yield" there reads as the ACGB, which is a different instrument.
  it("labels every non-Australian rate and currency with its country", () => {
    for (const series of GLOBAL_ECONOMY_SERIES) {
      if (series.group !== "us-rates" && series.group !== "us-macro") continue;
      expect(series.label).toMatch(/US|Fed/);
    }
  });

  it("feeds the industry correlation overlays", () => {
    const overlayKeys = new Set(
      NATIONAL_ECONOMY_OVERLAYS.map((overlay) => overlay.key),
    );
    for (const series of GLOBAL_ECONOMY_SERIES) {
      if (series.overlay === false) continue;
      expect(overlayKeys.has(series.key)).toBe(true);
    }
  });

  // Every overlay carries a group, so the picker renders grouped rather than
  // falling back to a flat row of ~50 chips.
  it("gives every national overlay a picker group", () => {
    for (const overlay of NATIONAL_ECONOMY_OVERLAYS) {
      expect(overlay.group).toBeTruthy();
    }
    const titles = Object.values(GLOBAL_GROUP_TITLES);
    expect(new Set(titles).size).toBe(titles.length);
  });

  // AUD/USD already exists as rates.aud_usd.aus from the RBA. A second one
  // from FRED would be two series behind one fact.
  it("does not duplicate the RBA's AUD/USD", () => {
    const keys = GLOBAL_ECONOMY_SERIES.map((series) => series.key);
    expect(keys).not.toContain("rates.aud_usd.aus");
    expect(keys.filter((key) => key.includes("aud"))).toHaveLength(0);
  });
});

describe("price and rate formatters", () => {
  // World prices span four orders of magnitude in one list. The compact
  // "number" format renders gold as "4.4K", which is why usd_price exists.
  it("scales precision to magnitude", () => {
    const usd = ECONOMY_SERIES_FORMATTERS.usd_price;
    expect(usd(4411)).toBe("$4,411");
    expect(usd(96.3)).toBe("$96.3");
    expect(usd(2.11)).toBe("$2.11");
    expect(usd(0.38)).toBe("$0.38");
  });

  // 2dp everywhere would render USD/EUR as 1.16 and throw away the moves.
  it("gives sub-10 exchange rates four decimals", () => {
    const fx = ECONOMY_SERIES_FORMATTERS.fx;
    expect(fx(1.1618)).toBe("1.1618");
    expect(fx(6.7108)).toBe("6.7108");
    expect(fx(156.11)).toBe("156.11");
  });
});
