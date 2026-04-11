import { NextRequest } from "next/server";
import { GET } from "../route";
import { listCommunityPulseItems } from "~/@/lib/community/firestore-community";

jest.mock("~/@/lib/community/firestore-community", () => ({
  listCommunityPulseItems: jest.fn(),
}));

describe("/api/community/[stockCode]/pulse", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the public pulse payload", async () => {
    (listCommunityPulseItems as jest.Mock).mockResolvedValue([
      {
        id: "pulse-1",
        stockCode: "CBA",
        body: "Desk chatter shifted after the downgrade.",
        score: 2,
        replyCount: 1,
        createdAt: new Date("2026-04-11T08:00:00Z"),
        updatedAt: new Date("2026-04-11T08:00:00Z"),
      },
    ]);

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/pulse",
    );
    const response = await GET(request, {
      params: Promise.resolve({ stockCode: "CBA" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.stockCode).toBe("CBA");
    expect(data.pulse).toHaveLength(1);
    expect(data.pulse[0]?.id).toBe("pulse-1");
  });
});
