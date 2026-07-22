import {
  ECONOMY_MAP_METRICS,
  ECONOMY_SERIES_FORMATTERS,
  METRIC_BY_KEY,
  seriesKeysFor,
  buildStateValues,
  yoyPct,
  rankOf,
  type EconomyMapMetric,
  type EconomySeriesMetric,
  type StateSeries,
} from "../map-metrics";

const mk = (state: string, values: number[], startYear = 2024): StateSeries => ({
  state,
  observations: values.map((v, i) => ({
    date: new Date(Date.UTC(startYear, i, 1)),
    value: v,
  })),
});

/** Test-side narrowing: fail loudly if a fixture key stops being a series metric. */
const asSeries = (m: EconomyMapMetric): EconomySeriesMetric => {
  if (m.kind !== "series") throw new Error(`${m.key} is not a series metric`);
  return m;
};

describe("map-metrics", () => {
  it("formats negative megalitres using the absolute threshold and signed value", () => {
    expect(ECONOMY_SERIES_FORMATTERS.megalitres(-1500)).toBe("-1.5GL");
  });

  it("registry has 12 metrics with unique keys", () => {
    const keys = ECONOMY_MAP_METRICS.map((m) => m.key);
    expect(keys).toHaveLength(12);
    expect(new Set(keys).size).toBe(12);
    expect(METRIC_BY_KEY.unemployment.label).toMatch(/unemployment/i);
  });

  it("registry kinds: 10 series + 2 aggregate", () => {
    const byKind = { series: 0, aggregate: 0 };
    for (const m of ECONOMY_MAP_METRICS) byKind[m.kind]++;
    expect(byKind).toEqual({ series: 10, aggregate: 2 });
  });

  it("registers retail turnover and derived population growth", () => {
    const retail = asSeries(METRIC_BY_KEY.retail);
    expect(retail.seriesKeyTemplate).toBe("retail.turnover.total.{state}.seasadj");
    expect(retail.format).toBe("aud");
    expect(seriesKeysFor(retail)).toContain("retail.turnover.total.nsw.seasadj");

    const population = asSeries(METRIC_BY_KEY.population_growth);
    expect(population.seriesKeyTemplate).toBe("population.erp.total.{state}");
    expect(population.format).toBe("percent");
    expect(population.palette).toBe("diverging");
    expect(population.derived).toBe("yoy");
  });

  it("aggregate metrics map to StateCompanyAggregate fields", () => {
    const footprint = METRIC_BY_KEY.company_footprint;
    expect(footprint.kind).toBe("aggregate");
    if (footprint.kind !== "aggregate") throw new Error("unreachable");
    expect(footprint.aggField).toBe("exposureWeightedMarketCap");
    expect(footprint.format).toBe("aud");

    const shortInterest = METRIC_BY_KEY.local_short_interest;
    expect(shortInterest.kind).toBe("aggregate");
    if (shortInterest.kind !== "aggregate") throw new Error("unreachable");
    expect(shortInterest.aggField).toBe("exposureWeightedShortPercent");
    expect(shortInterest.format).toBe("percent");
    expect(shortInterest.higherIsBad).toBe(true);
  });

  it("seriesKeysFor rejects aggregate metrics at compile time", () => {
    const agg = METRIC_BY_KEY.company_footprint;
    // type-only check — never executed (aggregates have no templates)
    const typeCheck = () => {
      // @ts-expect-error seriesKeysFor takes EconomySeriesMetric only
      seriesKeysFor(agg);
    };
    void typeCheck;
    expect(agg.kind).toBe("aggregate");
  });

  it("seriesKeysFor templates state slugs and skips unavailable states", () => {
    const keys = seriesKeysFor(asSeries(METRIC_BY_KEY.unemployment));
    expect(keys).toContain("labour.unemployment_rate.total.nsw.seasadj");
    expect(keys.some((k) => k.includes(".nt."))).toBe(false);
    expect(keys.some((k) => k.endsWith(".nt.seasadj"))).toBe(false);
  });

  it("trade_balance fetches both directions", () => {
    const keys = seriesKeysFor(asSeries(METRIC_BY_KEY.trade_balance));
    expect(keys).toContain("trade.export_value.total.wa");
    expect(keys).toContain("trade.import_value.total.wa");
  });

  it("yoyPct computes % change vs ~12 months earlier", () => {
    const s = mk("nsw", Array.from({ length: 13 }, (_, i) => 100 + i)); // 100..112
    expect(yoyPct(s.observations)).toBeCloseTo(12, 5);
    expect(yoyPct(s.observations.slice(0, 6))).toBeNull(); // < a year of data
  });

  it("buildStateValues: plain metric uses latest value", () => {
    const values = buildStateValues(asSeries(METRIC_BY_KEY.unemployment), {
      nsw: mk("nsw", [4.5, 4.2]),
      vic: mk("vic", [4.8, 4.9]),
    });
    expect(values.get("NSW")?.latest).toBe(4.2);
    expect(values.get("VIC")?.latest).toBe(4.9);
  });

  it("buildStateValues: derived balance = exports − imports per state", () => {
    const values = buildStateValues(asSeries(METRIC_BY_KEY.trade_balance), {
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
