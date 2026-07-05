import { NextRequest } from "next/server";
import { GET } from "../route";
import { getCachedStockCommunitySummary } from "~/@/lib/community/community-summary-cache";

jest.mock("~/@/lib/community/community-summary-cache", () => ({
  COMMUNITY_SUMMARY_CACHE_SECONDS: 120,
  getCachedStockCommunitySummary: jest.fn(),
}));

describe("/api/community/[stockCode]/summary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the public stock community summary payload", async () => {
    (getCachedStockCommunitySummary as jest.Mock).mockResolvedValue({
      headline: "Most active thread right now",
      subheadline: "6 threads and 14 pulse updates live now",
      ctaLabel: "Open community",
      threadCount: 6,
      pulseCount: 14,
    });

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/summary",
    );
    const response = await GET(request, {
      params: Promise.resolve({ stockCode: "CBA" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.stockCode).toBe("CBA");
    expect(data.summary.headline).toBe("Most active thread right now");
  });
});
