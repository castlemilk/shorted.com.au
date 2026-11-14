import { unstable_noStore } from "next/cache";
import { getCachedStockCommunitySummary } from "../community-summary-cache";
import { getStockCommunitySummary } from "../community-repository";

const mockDataCache = new Map<string, unknown>();
jest.mock("next/cache", () => ({
  unstable_noStore: jest.fn(),
  unstable_cache: jest.fn((loader, key) => async () => {
    const cacheKey = JSON.stringify(key);
    if (!mockDataCache.has(cacheKey))
      mockDataCache.set(cacheKey, await loader());
    return mockDataCache.get(cacheKey);
  }),
}));
jest.mock("../community-repository", () => ({
  getStockCommunitySummary: jest.fn(),
}));

describe("community summary freshness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDataCache.clear();
  });

  it("does not replay a title from a thread removed after an earlier summary read", async () => {
    (getStockCommunitySummary as jest.Mock).mockResolvedValue({
      headline: "Previously public title",
    });
    expect((await getCachedStockCommunitySummary("bhp")).headline).toBe(
      "Previously public title",
    );
    (getStockCommunitySummary as jest.Mock).mockResolvedValue({
      headline: "Be the first to discuss BHP",
    });

    expect((await getCachedStockCommunitySummary("bhp")).headline).toBe(
      "Be the first to discuss BHP",
    );
    expect(unstable_noStore).toHaveBeenCalled();
    expect(getStockCommunitySummary).toHaveBeenCalledWith("BHP");
  });
});
