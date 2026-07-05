import { unstable_cache } from "next/cache";
import {
  COMMUNITY_SUMMARY_CACHE_SECONDS,
  communitySummaryCacheTag,
  getCachedStockCommunitySummary,
} from "../community-summary-cache";
import { getStockCommunitySummary } from "../firestore-community";

jest.mock("next/cache", () => ({
  unstable_cache: jest.fn((loader) => loader),
}));

jest.mock("../firestore-community", () => ({
  getStockCommunitySummary: jest.fn(),
}));

describe("community summary cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("wraps stock community summaries in a short tagged data cache", async () => {
    (getStockCommunitySummary as jest.Mock).mockResolvedValue({
      headline: "Open community",
      subheadline: "",
      ctaLabel: "Open community",
      threadCount: 0,
      pulseCount: 0,
    });

    const summary = await getCachedStockCommunitySummary("bhp");

    expect(summary.threadCount).toBe(0);
    expect(getStockCommunitySummary).toHaveBeenCalledWith("BHP");
    expect(communitySummaryCacheTag("bhp")).toBe("community-summary:BHP");
    expect(unstable_cache).toHaveBeenCalledWith(
      expect.any(Function),
      ["community-summary", "BHP"],
      {
        revalidate: COMMUNITY_SUMMARY_CACHE_SECONDS,
        tags: ["community-summary:BHP"],
      },
    );
  });
});
