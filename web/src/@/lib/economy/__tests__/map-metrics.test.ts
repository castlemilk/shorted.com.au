import {
  ECONOMY_MAP_METRICS,
  METRIC_BY_KEY,
  seriesKeysFor,
  buildStateValues,
  yoyPct,
  rankOf,
  type StateSeries,
} from "../map-metrics";

const mk = (state: string, values: number[], startYear = 2024): StateSeries => ({
  state,
  observations: values.map((v, i) => ({
    date: new Date(Date.UTC(startYear, i, 1)),
    value: v,
  })),
});

describe("map-metrics", () => {
  it("registry has 8 metrics with unique keys", () => {
    const keys = ECONOMY_MAP_METRICS.map((m) => m.key);
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(8);
    expect(METRIC_BY_KEY.unemployment.label).toMatch(/unemployment/i);
  });

  it("seriesKeysFor templates state slugs and skips unavailable states", () => {
    const keys = seriesKeysFor(METRIC_BY_KEY.unemployment);
    expect(keys).toContain("labour.unemployment_rate.total.nsw.seasadj");
    expect(keys.some((k) => k.includes(".nt."))).toBe(false);
    expect(keys.some((k) => k.endsWith(".nt.seasadj"))).toBe(false);
  });

  it("trade_balance fetches both directions", () => {
    const keys = seriesKeysFor(METRIC_BY_KEY.trade_balance);
    expect(keys).toContain("trade.export_value.total.wa");
    expect(keys).toContain("trade.import_value.total.wa");
  });

  it("yoyPct computes % change vs ~12 months earlier", () => {
    const s = mk("nsw", Array.from({ length: 13 }, (_, i) => 100 + i)); // 100..112
    expect(yoyPct(s.observations)).toBeCloseTo(12, 5);
    expect(yoyPct(s.observations.slice(0, 6))).toBeNull(); // < a year of data
  });

  it("buildStateValues: plain metric uses latest value", () => {
    const values = buildStateValues(METRIC_BY_KEY.unemployment, {
      nsw: mk("nsw", [4.5, 4.2]),
      vic: mk("vic", [4.8, 4.9]),
    });
    expect(values.get("NSW")?.latest).toBe(4.2);
    expect(values.get("VIC")?.latest).toBe(4.9);
  });

  it("buildStateValues: derived balance = exports − imports per state", () => {
    const values = buildStateValues(METRIC_BY_KEY.trade_balance, {
      "wa:export": mk("wa", [100, 120]),
      "wa:import": mk("wa", [80, 90]),
    });
    expect(values.get("WA")?.latest).toBe(30);
  });

  it("rankOf ranks descending with 1 = highest", () => {
    const m = new Map([
      ["NSW", 5],
      ["VIC", 9],
      ["QLD", 7],
    ]);
    expect(rankOf(m, "VIC")).toEqual({ rank: 1, of: 3 });
    expect(rankOf(m, "NSW")).toEqual({ rank: 3, of: 3 });
  });
});
