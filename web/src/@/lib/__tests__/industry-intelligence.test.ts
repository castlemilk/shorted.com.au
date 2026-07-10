import {
  buildEvidenceChannels,
  buildIndustryCrowdingSeries,
  buildIndustryIntelligenceStory,
  buildIndustryIntelligenceStories,
  changeOverLag,
  getStockCrowdingStatus,
  trailingSma,
  trailingZScore,
} from "../industry-intelligence";

const materialsIndustry = {
  name: "Materials",
  slug: "materials",
  stockCount: 3,
  avgShortPercent: 8.2,
  totalShortPercent: 24.6,
  topStock: {
    code: "MIN",
    name: "MIN",
    shortPercent: 12.4,
  },
};

const materialsStocks = [
  { code: "PLS", name: "Pilbara Minerals", shortPercent: 6.8, change: -0.2 },
  { code: "MIN", name: "Mineral Resources", shortPercent: 12.4, change: 1.3 },
  { code: "LTR", name: "Liontown Resources", shortPercent: 9.1, change: 0 },
];

describe("industry intelligence story model", () => {
  it("builds a cited story with sorted top industry stocks", () => {
    const story = buildIndustryIntelligenceStory({
      industry: materialsIndustry,
      stocks: materialsStocks,
      asAt: "2026-07-08",
    });

    expect(story.industry.slug).toBe("materials");
    expect(story.topShortedStocks.map((stock) => stock.code)).toEqual([
      "MIN",
      "LTR",
      "PLS",
    ]);
    expect(story.topShortedStocks[0]).toMatchObject({
      rank: 1,
      shortPercent: 12.4,
      status: "crowded",
      href: "/shorts/MIN",
      detail: "Materials company",
    });
    expect(story.shortSignals.source.name).toBe("ASIC");
    expect(story.shortSignals.source.asAt).toBe("2026-07-08");
  });

  it("does not expose planned public-data modules in the public story model", () => {
    const story = buildIndustryIntelligenceStory({
      industry: materialsIndustry,
      stocks: materialsStocks,
      asAt: "2026-07-08",
    });

    expect(story).not.toHaveProperty("tradeExposure");
    expect(story).not.toHaveProperty("publicMoney");
    expect(story).not.toHaveProperty("taxEnvironment");
    expect(story).not.toHaveProperty("policyFootprint");
    expect(story.alerts.cadences).toEqual(["Daily", "Weekly"]);
  });

  it("builds multiple stories and keeps a deterministic fallback for empty stock lists", () => {
    const stories = buildIndustryIntelligenceStories({
      industries: [
        materialsIndustry,
        {
          name: "Health Care",
          slug: "health-care",
          stockCount: 0,
          avgShortPercent: 0,
          totalShortPercent: 0,
          topStock: null,
        },
      ],
      stocksByIndustry: {
        materials: materialsStocks,
        "health-care": [],
      },
      asAt: "2026-07-08",
    });

    expect(stories).toHaveLength(2);
    expect(stories[1]?.topShortedStocks).toEqual([]);
    expect(stories[1]?.shortSignals.highlyShortedCount).toBe(0);
  });

  it.each([
    [12.1, "crowded"],
    [7.4, "elevated"],
    [2.2, "watching"],
  ] as const)("maps %p short interest to %s status", (shortPercent, status) => {
    expect(getStockCrowdingStatus(shortPercent)).toBe(status);
  });
});

const atoSource = {
  sourceKey: "ato-corporate-tax-transparency",
  displayName: "ATO Corporate Tax Transparency",
  publisher: "Australian Taxation Office",
  sourceUrl: "https://data.gov.au/data/dataset/corporate-transparency",
  licence: "CC-BY-3.0-AU",
};

const taxRecord = {
  sourceKey: "ato-corporate-tax-transparency",
  signalKind: "tax_environment",
  stockCode: "MIN",
  title: "ATO tax transparency: Mineral Resources 2024",
  summary: "ATO reported total income for Mineral Resources.",
  metricKey: "total_income",
  metricLabel: "Total income",
  metricValue: 5_000_000_000,
  unit: "AUD",
  asOf: "2024-06-30",
  sourceUrl: "https://data.gov.au/data/dataset/corporate-transparency",
};

const taxBucket = {
  signalKind: "tax_environment",
  sourceKey: "ato-corporate-tax-transparency",
  metricKey: "tax_payable",
  metricLabel: "Tax payable",
  unit: "AUD",
  bucketLabel: "2023-24",
  bucketStart: "2023-07-01",
  totalValue: 1_200_000_000,
  recordCount: 12,
  entityCount: 12,
  zeroValueCount: 0,
};

describe("buildEvidenceChannels", () => {
  it("groups records and aggregates into channels with neutral labels", () => {
    const channels = buildEvidenceChannels({
      sources: [atoSource],
      records: [taxRecord],
      timeBuckets: [taxBucket],
      entityTotals: [
        {
          signalKind: "tax_environment",
          sourceKey: "ato-corporate-tax-transparency",
          metricKey: "tax_payable",
          stockCode: "MIN",
          entityLabel: "Mineral Resources",
          unit: "AUD",
          totalValue: 900_000_000,
          recordCount: 8,
          latestAsOf: "2024-06-30",
        },
      ],
    });

    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      kind: "tax_environment",
      label: "Tax Environment",
      latestAsOf: "2024-06-30",
    });
    expect(channels[0]!.caveat).toMatch(/lawful provisions/);
    expect(channels[0]!.sources.map((s) => s.sourceKey)).toEqual([
      "ato-corporate-tax-transparency",
    ]);
    expect(channels[0]!.timeBuckets).toHaveLength(1);
    expect(channels[0]!.entityTotals).toHaveLength(1);
  });

  it("drops channels without any imported evidence", () => {
    const channels = buildEvidenceChannels({
      sources: [atoSource],
      records: [],
      timeBuckets: [],
      entityTotals: [],
    });
    expect(channels).toEqual([]);
  });

  it("orders channels by the fixed signal-kind order", () => {
    const mkBucket = (signalKind: string, sourceKey: string) => ({
      ...taxBucket,
      signalKind,
      sourceKey,
    });
    const channels = buildEvidenceChannels({
      sources: [],
      records: [],
      timeBuckets: [
        mkBucket("policy_footprint", "aec-transparency-register"),
        mkBucket("public_money", "austender-contract-notices"),
        mkBucket("tax_environment", "ato-corporate-tax-transparency"),
      ],
    });
    expect(channels.map((c) => c.kind)).toEqual([
      "tax_environment",
      "public_money",
      "policy_footprint",
    ]);
  });
});

describe("buildIndustryCrowdingSeries", () => {
  const mkPoints = (values: [string, number][]) =>
    values.map(([date, value]) => ({ date, value }));

  it("buckets by ISO week with a p10-p90 band and 2dp rounding", () => {
    const series = buildIndustryCrowdingSeries([
      {
        code: "AAA",
        points: mkPoints([
          ["2026-06-01", 2.005],
          ["2026-06-08", 3],
          ["2026-06-15", 4],
        ]),
      },
      {
        code: "BBB",
        points: mkPoints([
          ["2026-06-02", 6],
          ["2026-06-09", 7],
          ["2026-06-16", 8],
        ]),
      },
      {
        code: "CCC",
        points: mkPoints([
          ["2026-06-03", 10],
          ["2026-06-10", 11],
          ["2026-06-17", 12],
        ]),
      },
    ]);

    expect(series).not.toBeNull();
    expect(series!.points).toHaveLength(3);
    expect(series!.points[0]).toMatchObject({
      date: "2026-06-01",
      avg: 6,
      constituents: 3,
    });
    expect(series!.points[0]!.p10).toBeCloseTo(2.8, 2);
    expect(series!.points[0]!.p90).toBeCloseTo(9.2, 2);
  });

  it("computes median, quartiles, and stddev per weekly bucket", () => {
    const series = buildIndustryCrowdingSeries([
      { code: "AAA", points: mkPoints([["2026-06-01", 2], ["2026-06-08", 2], ["2026-06-15", 2]]) },
      { code: "BBB", points: mkPoints([["2026-06-01", 6], ["2026-06-08", 6], ["2026-06-15", 6]]) },
      { code: "CCC", points: mkPoints([["2026-06-01", 10], ["2026-06-08", 10], ["2026-06-15", 10]]) },
    ]);

    expect(series).not.toBeNull();
    const first = series!.points[0]!;
    expect(first.median).toBe(6);
    expect(first.p25).toBe(4);
    expect(first.p75).toBe(8);
    // population stddev of [2, 6, 10] = sqrt(32/3) ≈ 3.27
    expect(first.stddev).toBeCloseTo(3.27, 2);
  });

  it("carries a stock's last value through gap weeks within its observed range", () => {
    const series = buildIndustryCrowdingSeries(
      [
        // AAA reports every week; BBB skips 06-08 (decimation artifact) but
        // reports again on 06-15 — its value 6 carries through the gap week.
        {
          code: "AAA",
          points: mkPoints([
            ["2026-06-01", 2],
            ["2026-06-08", 3],
            ["2026-06-15", 4],
          ]),
        },
        {
          code: "BBB",
          points: mkPoints([
            ["2026-06-01", 6],
            ["2026-06-15", 8],
          ]),
        },
      ],
      { minConstituents: 2 },
    );

    expect(series).not.toBeNull();
    expect(series!.points.map((p) => p.date)).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
    ]);
    // Gap week: AAA fresh (3), BBB carried (6).
    expect(series!.points[1]).toMatchObject({ avg: 4.5, constituents: 2 });
  });

  it("never extrapolates beyond a stock's last observation", () => {
    const series = buildIndustryCrowdingSeries(
      [
        {
          code: "AAA",
          points: mkPoints([
            ["2026-06-01", 2],
            ["2026-06-08", 3],
            ["2026-06-15", 4],
            ["2026-06-22", 5],
          ]),
        },
        {
          code: "BBB",
          points: mkPoints([
            ["2026-06-01", 6],
            ["2026-06-08", 7],
            ["2026-06-15", 8],
          ]),
        },
      ],
      { minConstituents: 2 },
    );

    expect(series).not.toBeNull();
    // 2026-06-22 would need BBB extrapolated past its last observation —
    // it stays a 1-constituent week and is dropped.
    expect(series!.points.map((p) => p.date)).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
    ]);
  });

  it("returns null when there are too few usable weekly buckets", () => {
    const sparse = buildIndustryCrowdingSeries([
      { code: "AAA", points: mkPoints([["2026-06-01", 2]]) },
      { code: "BBB", points: mkPoints([["2026-06-02", 6]]) },
    ]);
    expect(sparse).toBeNull();
  });

  it("drops weeks below the minimum constituent count", () => {
    const series = buildIndustryCrowdingSeries(
      [
        {
          code: "AAA",
          points: mkPoints([
            ["2026-06-01", 2],
            ["2026-06-08", 3],
            ["2026-06-15", 4],
            ["2026-06-22", 5],
          ]),
        },
        {
          code: "BBB",
          points: mkPoints([
            ["2026-06-01", 6],
            ["2026-06-08", 7],
            ["2026-06-15", 8],
          ]),
        },
      ],
      { minConstituents: 2 },
    );
    expect(series).not.toBeNull();
    // The 2026-06-22 week only has one constituent and is dropped.
    expect(series!.points.map((p) => p.date)).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
    ]);
  });
});

describe("crowding view math helpers", () => {
  it("trailingSma yields null until the period fills, then the window mean", () => {
    expect(trailingSma([2, 4, 6, 8], 3)).toEqual([null, null, 4, 6]);
  });

  it("changeOverLag is the pp difference vs `lag` observations ago", () => {
    expect(changeOverLag([5, 6, 6.5, 6], 2)).toEqual([null, null, 1.5, 0]);
  });

  it("trailingZScore needs minObs history and guards flat windows", () => {
    const flat = trailingZScore([3, 3, 3, 3, 3], 4, 3);
    expect(flat).toEqual([null, null, null, null, null]);

    const values = [1, 2, 3, 4, 10];
    const z = trailingZScore(values, 5, 3);
    expect(z[0]).toBeNull();
    expect(z[1]).toBeNull();
    // window [1..3]: mean 2, sd sqrt(2/3)≈0.816 → z(3) ≈ 1.22
    expect(z[2]).toBeCloseTo(1.22, 2);
    // window [1,2,3,4,10]: mean 4, sd ≈ 3.16 → z(10) ≈ 1.9
    expect(z[4]).toBeCloseTo(1.9, 2);
  });
});
