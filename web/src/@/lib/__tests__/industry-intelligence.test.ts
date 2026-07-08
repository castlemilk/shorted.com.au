import {
  buildIndustryIntelligenceStory,
  buildIndustryIntelligenceStories,
  getStockCrowdingStatus,
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
    });
    expect(story.shortSignals.source.name).toBe("ASIC");
    expect(story.shortSignals.source.asAt).toBe("2026-07-08");
  });

  it("marks non-live public-data channels as source-ready without invented values", () => {
    const story = buildIndustryIntelligenceStory({
      industry: materialsIndustry,
      stocks: materialsStocks,
      asAt: "2026-07-08",
    });

    expect(story.tradeExposure.status).toBe("source-ready");
    expect(story.publicMoney.status).toBe("source-ready");
    expect(story.taxEnvironment.status).toBe("source-ready");
    expect(story.policyFootprint.status).toBe("source-ready");
    expect(story.tradeExposure.value).toBeNull();
    expect(story.publicMoney.value).toBeNull();
    expect(story.policyFootprint.value).toBeNull();
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

