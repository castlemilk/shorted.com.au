import {
  HIGHLIGHT_METRICS,
  amberScale,
  crimeRankScale,
  publishableNbnTech,
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

describe("NBN technology", () => {
  const nbn = HIGHLIGHT_METRICS.find((m) => m.key === "nbn");

  test("a populous suburb classed Satellite is no data, on the map and the tile", () => {
    // Bondi (10,411 people) read "NBN SATELLITE" from the old join's fallback.
    expect(publishableNbnTech("Satellite", 10_411)).toBeNull();
    expect(nbn?.kind === "categorical" && nbn.category({ ...baseSuburb, dominantNbnTech: "Satellite", population: 10_411 })).toBeNull();
  });

  test("genuinely remote satellite suburbs and every other technology pass through", () => {
    expect(publishableNbnTech("Satellite", 1_000)).toBe("Satellite");
    expect(publishableNbnTech("Satellite", 180)).toBe("Satellite");
    expect(publishableNbnTech("Fixed Line", 66_781)).toBe("Fixed Line");
    expect(publishableNbnTech("Fixed Wireless", 5_000)).toBe("Fixed Wireless");
    expect(nbn?.kind === "categorical" && nbn.category({ ...baseSuburb, dominantNbnTech: "Fixed Line" })).toBe("Fixed Line");
  });

  test("an unclassified suburb is no data, not a tier", () => {
    expect(publishableNbnTech("", 5_000)).toBeNull();
    expect(publishableNbnTech(undefined, 5_000)).toBeNull();
  });
});

describe("language", () => {
  const language = HIGHLIGHT_METRICS.find((m) => m.key === "language");
  const category = (over: Partial<SuburbMetricInput>) =>
    language?.kind === "categorical" ? language.category({ ...baseSuburb, ...over }) : undefined;

  test("a suburb below the Census culture floor is no data, not 'English'", () => {
    // The collector withholds label and share under 100 residents.
    expect(category({ population: 80, topLanguage: "", pctTopLanguage: 0 })).toBeNull();
    expect(category({ population: 0 })).toBeNull();
  });

  test("at the floor, a thin or absent top language still reads as the English base", () => {
    expect(category({ population: 100, topLanguage: "", pctTopLanguage: 0 })).toBe("English");
    expect(category({ population: 5_000, topLanguage: "Greek", pctTopLanguage: 3 })).toBe("English");
    expect(category({ population: 5_000, topLanguage: "Greek", pctTopLanguage: 12 })).toBe("Greek");
  });
});
