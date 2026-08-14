import {
  HIGHLIGHT_METRICS,
  amberScale,
  crimeRankScale,
  type MetricKey,
  type SuburbMetricInput,
} from "./highlight-metrics";

const baseSuburb: SuburbMetricInput = {
  latestMedianPrice: 0,
  population: 10_000,
  medianAge: 0,
  medianWeeklyHhdIncome: 0,
  pctBornOverseas: 0,
  topReligion: "",
  topLanguage: "",
  pctTopLanguage: 0,
  federalPartyAb: "",
  federalTppAlp: 0,
  statePartyAb: "",
  schoolsTotal: 0,
  schoolsGov: 0,
  schoolsCatholic: 0,
  schoolsIndependent: 0,
  supermarketsTotal: 0,
  colesCount: 0,
  woolworthsCount: 0,
  aldiCount: 0,
  igaCount: 0,
  pubsBars: 0,
  amenityDensityScore: 0,
  gpCount: 0,
  nearestTrainKm: 0,
  distToCoastKm: 0,
  dominantNbnTech: "",
  crimeBreakInsRank: 0,
  crimeViolentRank: 0,
  crimeMotorVehicleRank: 0,
};

describe("crime highlight metrics", () => {
  const cases = [
    ["crime_break_ins", "crimeBreakInsRank"],
    ["crime_violent", "crimeViolentRank"],
    ["crime_motor_vehicle", "crimeMotorVehicleRank"],
  ] as const satisfies ReadonlyArray<[MetricKey, keyof SuburbMetricInput]>;

  test.each(cases)("%s uses rank zero as no data", (key, field) => {
    const metric = HIGHLIGHT_METRICS.find((candidate) => candidate.key === key);
    expect(metric).toBeDefined();
    expect(metric?.kind).toBe("continuous");
    if (!metric || metric.kind !== "continuous") return;

    expect(metric.domain).toEqual([0, 100]);
    expect(metric.value(baseSuburb)).toBeNull();
    expect(metric.value({ ...baseSuburb, [field]: 50 })).toBe(50);
  });

  test("uses a dedicated yellow-to-red danger ramp", () => {
    const danger = crimeRankScale();
    expect(danger(0)).not.toBe(danger(100));
    expect(danger(50)).not.toBe(amberScale(0, 100)(50));
  });
});
