import { NextRequest } from "next/server";
import { GET } from "../route";
import { getStockCommunitySummary } from "~/@/lib/community/firestore-community";

jest.mock("~/@/lib/community/firestore-community", () => ({
  getStockCommunitySummary: jest.fn(),
}));

describe("/api/community/[stockCode]/summary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the public stock community summary payload", async () => {
    (getStockCommunitySummary as jest.Mock).mockResolvedValue({
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
