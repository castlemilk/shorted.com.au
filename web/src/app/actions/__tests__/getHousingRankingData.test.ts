const unstableCache = jest.fn((callback: () => Promise<unknown>) => callback);
const listStateSuburbsOutsideNextCache = jest.fn();
const skipForBuild = jest.fn(() => false);

jest.mock("next/cache", () => ({
  unstable_cache: (...args: unknown[]) => unstableCache(...args),
}));
jest.mock("../getHousing", () => ({
  listStateSuburbsOutsideNextCache: (...args: unknown[]) =>
    listStateSuburbsOutsideNextCache(...args),
}));
jest.mock("../config", () => ({
  skipForBuild: () => skipForBuild(),
}));

import { getHousingRankingData } from "../getHousingRankingData";

const fullSuburb = {
  salCode: "10001",
  salName: "ALPHA",
  stateCode: "NSW",
  postcode: "2000",
  latestMedianPrice: 825_000,
  latestPeriod: { seconds: BigInt(1_750_000_000), nanos: 0 },
  yoyPct: 6.25,
  population: 4_500,
  medianAge: 38,
  medianWeeklyHhdIncome: 2_100,
  regionCode: "1GSYD",
  pctBornOverseas: 30,
  topReligion: "No Religion",
};

describe("getHousingRankingData", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    skipForBuild.mockReturnValue(false);
    listStateSuburbsOutsideNextCache.mockResolvedValue({
      suburbs: [fullSuburb],
    });
  });

  it("caches one compact, serializable state projection", async () => {
    await expect(getHousingRankingData("NSW")).resolves.toEqual({
      asOfDate: "2025-06-15",
      suburbs: [
        {
          salCode: "10001",
          salName: "ALPHA",
          stateCode: "NSW",
          postcode: "2000",
          latestMedianPrice: 825_000,
          yoyPct: 6.25,
          population: 4_500,
          medianWeeklyHhdIncome: 2_100,
        },
      ],
    });

    expect(listStateSuburbsOutsideNextCache).toHaveBeenCalledWith("NSW", 5000);
    expect(unstableCache).toHaveBeenCalledWith(
      expect.any(Function),
      ["housing-ranking-suburbs-nsw-v1"],
      {
        tags: ["housing", "housing-rankings", "housing-ranking-nsw"],
        revalidate: 3600,
      },
    );
  });

  it("returns null without touching the API during a skipped build", async () => {
    skipForBuild.mockReturnValue(true);

    await expect(getHousingRankingData("NSW")).resolves.toBeNull();
    expect(listStateSuburbsOutsideNextCache).not.toHaveBeenCalled();
  });

  it("does not cache an empty or entirely unpriced response", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    listStateSuburbsOutsideNextCache.mockResolvedValue({
      suburbs: [
        { ...fullSuburb, latestMedianPrice: 0, latestPeriod: undefined },
      ],
    });

    await expect(getHousingRankingData("NSW")).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(
      "[getHousingRankingData] failed for NSW:",
      expect.any(Error),
    );
    error.mockRestore();
  });
});
