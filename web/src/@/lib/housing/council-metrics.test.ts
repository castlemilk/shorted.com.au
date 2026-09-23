import {
  COUNCIL_METRICS,
  COUNCIL_METRIC_BY_KEY,
  DEFAULT_COUNCIL_METRIC,
  councilMetricScale,
  isCouncilMetricKey,
  type CouncilMetricInput,
} from "./council-metrics";

const base: CouncilMetricInput = {
  population: 101_356, erpYear: 2025,
  popGrowthPct: undefined, densityPerSqkm: undefined, councilHouseMedian: undefined,
  councilHouseMedianPeriod: "", fagPerResident: undefined, fagYear: "",
  approvalsPer1000: undefined, approvalsThrough: "", seifaIrsadDecile: undefined,
  floodSharePct: undefined, bushfireSharePct: undefined, priceDropShare: undefined,
};

describe("council metric registry", () => {
  test("keys are unique, serializable strings and the default exists", () => {
    const keys = COUNCIL_METRICS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(isCouncilMetricKey(DEFAULT_COUNCIL_METRIC)).toBe(true);
    expect(isCouncilMetricKey("price")).toBe(false); // a suburb key is not a council key
    expect(isCouncilMetricKey("__proto__")).toBe(false);
    expect(isCouncilMetricKey(null)).toBe(false);
  });

  test("covers every metric the council choropleth promises", () => {
    expect(COUNCIL_METRICS.map((m) => m.key).sort()).toEqual([
      "approvals_per_1000", "bushfire_share", "density", "fag_per_resident", "flood_share",
      "house_median", "irsad_decile", "population", "population_growth", "price_drop_share",
    ]);
  });

  test("an absent fact is no data, never a zero", () => {
    for (const m of COUNCIL_METRICS) {
      if (m.key === "population") continue;
      expect({ key: m.key, value: m.value(base) }).toEqual({ key: m.key, value: null });
    }
    expect(COUNCIL_METRIC_BY_KEY.population.value({ ...base, population: 0 })).toBeNull();
  });

  test("a measured zero stays a zero", () => {
    expect(COUNCIL_METRIC_BY_KEY.flood_share.value({ ...base, floodSharePct: 0 })).toBe(0);
    expect(COUNCIL_METRIC_BY_KEY.population_growth.value({ ...base, popGrowthPct: 0 })).toBe(0);
  });

  test("dated facts need their date: an undated council median or grant is not shown", () => {
    expect(COUNCIL_METRIC_BY_KEY.house_median.value({ ...base, councilHouseMedian: 900_000 })).toBeNull();
    expect(COUNCIL_METRIC_BY_KEY.house_median.value({ ...base, councilHouseMedian: 900_000, councilHouseMedianPeriod: "2023-24" })).toBe(900_000);
    expect(COUNCIL_METRIC_BY_KEY.fag_per_resident.value({ ...base, fagPerResident: 50 })).toBeNull();
    expect(COUNCIL_METRIC_BY_KEY.approvals_per_1000.value({ ...base, approvalsPer1000: 12 })).toBeNull();
  });

  test("the council median is labelled council-wide and sourced with its year", () => {
    const m = COUNCIL_METRIC_BY_KEY.house_median;
    expect(m.label).toMatch(/council-wide/i);
    expect(m.source({ ...base, councilHouseMedianPeriod: "2023-24" })).toContain("2023-24");
  });

  test("price-drop share is shown as a percentage of the 0..1 fraction", () => {
    expect(COUNCIL_METRIC_BY_KEY.price_drop_share.value({ ...base, priceDropShare: 0.042 })).toBeCloseTo(4.2);
    expect(COUNCIL_METRIC_BY_KEY.price_drop_share.source(undefined)).toMatch(/3\+/);
  });

  test("growth diverges around zero; deciles use their fixed 1..10 domain", () => {
    const growth = councilMetricScale(COUNCIL_METRIC_BY_KEY.population_growth, [-2, 3]);
    expect(growth.scale(0)).not.toBe(growth.scale(3));
    expect(growth.scale(-2)).not.toBe(growth.scale(2));
    const deciles = councilMetricScale(COUNCIL_METRIC_BY_KEY.irsad_decile, [4, 5]);
    expect([deciles.min, deciles.max]).toEqual([1, 10]);
  });

  test("formats read like the rest of the housing map", () => {
    expect(COUNCIL_METRIC_BY_KEY.population.format(389_687)).toBe("390k");
    expect(COUNCIL_METRIC_BY_KEY.population_growth.format(1.05)).toBe("+1.1%");
    expect(COUNCIL_METRIC_BY_KEY.flood_share.format(0.4)).toBe("<1%");
    expect(COUNCIL_METRIC_BY_KEY.irsad_decile.format(7)).toBe("Decile 7");
  });
});
