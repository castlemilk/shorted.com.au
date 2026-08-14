import { create } from "@bufbuild/protobuf";

import { GetEconomicSeriesResponseSchema } from "~/gen/shorts/v1alpha1/economy_pb";
import {
  ECONOMY_MAP_METRICS,
  ECONOMY_SERIES_FORMATTERS,
  METRIC_BY_KEY,
  STATE_CORRELATION_CANDIDATES,
  seriesKeysFor,
  buildStateValues,
  observationsFor,
  yoyPct,
  rankOf,
  type EconomyMapMetric,
  type EconomySeriesMetric,
  type StateSeries,
} from "../map-metrics";

const mk = (
  state: string,
  values: number[],
  startYear = 2024,
): StateSeries => ({
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
  it("converts proto observations, dropping unset/invalid periods and sorting ascending", () => {
    const response = create(GetEconomicSeriesResponseSchema, {
      series: [
        {
          info: { seriesKey: "example.series" },
          observations: [
            { period: { seconds: 1_704_067_200n }, value: 20 },
            { value: 999 },
            { period: { seconds: 9_000_000_000_000n }, value: 888 },
            { period: { seconds: 1_672_531_200n }, value: 10 },
          ],
        },
      ],
    });

    expect(observationsFor(response, "example.series")).toEqual([
      { date: new Date("2023-01-01T00:00:00.000Z"), value: 10 },
      { date: new Date("2024-01-01T00:00:00.000Z"), value: 20 },
    ]);
    expect(observationsFor(response, "missing.series")).toEqual([]);
  });

  it("formats negative megalitres using the absolute threshold and signed value", () => {
    expect(ECONOMY_SERIES_FORMATTERS.megalitres(-1500)).toBe("-1.5GL");
  });

  it("formats per-100k rates as unscaled decimal values without compact suffixes", () => {
    expect(ECONOMY_SERIES_FORMATTERS.rate(1.46)).toBe("1.5");
    expect(ECONOMY_SERIES_FORMATTERS.rate(189.8)).toBe("190");
  });

  it("registry has 15 metrics with unique keys", () => {
    const keys = ECONOMY_MAP_METRICS.map((m) => m.key);
    expect(keys).toHaveLength(15);
    expect(new Set(keys).size).toBe(15);
    expect(METRIC_BY_KEY.unemployment.label).toMatch(/unemployment/i);
  });

  it("registry kinds: 13 series + 2 aggregate", () => {
    const byKind = { series: 0, aggregate: 0 };
    for (const m of ECONOMY_MAP_METRICS) byKind[m.kind]++;
    expect(byKind).toEqual({ series: 13, aggregate: 2 });
  });

  it("registers household spending YoY as the sole round-2 map metric", () => {
    const spending = asSeries(METRIC_BY_KEY.spending_household_yoy);
    expect(spending.seriesKeyTemplate).toBe(
      "spending.household_yoy.total.{state}.seasadj",
    );
    expect(spending.format).toBe("percent");
    expect(spending.palette).toBe("diverging");
    expect(spending.derived).toBeUndefined();
  });

  it("registers dwelling approvals and construction work done as map metrics", () => {
    const approvals = asSeries(METRIC_BY_KEY.dwelling_approvals);
    expect(approvals.seriesKeyTemplate).toBe(
      "approvals.dwelling_units.total.{state}",
    );
    expect(approvals.format).toBe("number");

    const construction = asSeries(METRIC_BY_KEY.construction_work_done);
    expect(construction.seriesKeyTemplate).toBe(
      "construction.work_done.total.{state}.seasadj",
    );
    expect(construction.format).toBe("aud");
  });

  it("registers round-2 state correlation candidates without annual crime", () => {
    const templates = STATE_CORRELATION_CANDIDATES.map(
      (candidate) => candidate.seriesKeyTemplate,
    );
    expect(templates).toEqual(
      expect.arrayContaining([
        "spending.household.total.{state}.seasadj",
        "lending.new_commitments.investor.{state}.seasadj",
        "construction.work_done.total.{state}.seasadj",
      ]),
    );
    expect(templates.some((template) => template.startsWith("crime."))).toBe(
      false,
    );
  });

  it("registers price-return and per-capita series only as correlation candidates", () => {
    const templates = STATE_CORRELATION_CANDIDATES.map(
      (candidate) => candidate.seriesKeyTemplate,
    );
    expect(templates).toEqual(
      expect.arrayContaining([
        "markets.price_return_index.{state}",
        "gdp.state_final_demand_per_capita.total.{state}.seasadj",
        "spending.household_per_capita.total.{state}.seasadj",
        "approvals.dwelling_units_per_100k.total.{state}",
      ]),
    );

    const mapTemplates = ECONOMY_MAP_METRICS.flatMap((metric) =>
      metric.kind === "series" ? [metric.seriesKeyTemplate] : [],
    );
    expect(
      mapTemplates.some(
        (template) =>
          template.includes("price_return_index") ||
          template.includes("per_capita") ||
          template.includes("per_100k"),
      ),
    ).toBe(false);
  });

  it("registers retail turnover and derived population growth", () => {
    const retail = asSeries(METRIC_BY_KEY.retail);
    expect(retail.seriesKeyTemplate).toBe(
      "retail.turnover.total.{state}.seasadj",
    );
    expect(retail.format).toBe("aud");
    expect(seriesKeysFor(retail)).toContain(
      "retail.turnover.total.nsw.seasadj",
    );

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
    const s = mk(
      "nsw",
      Array.from({ length: 13 }, (_, i) => 100 + i),
    ); // 100..112
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
