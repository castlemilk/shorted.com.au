import { NextRequest } from "next/server";
import { GET } from "../route";
import { listCommunityThreads } from "~/@/lib/community/firestore-community";

jest.mock("~/@/lib/community/firestore-community", () => ({
  listCommunityThreads: jest.fn(),
}));

describe("/api/community/[stockCode]/threads", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the public thread list payload", async () => {
    (listCommunityThreads as jest.Mock).mockResolvedValue([
      {
        id: "thread-1",
        stockCode: "CBA",
        type: "bull",
        title: "Capital discipline is improving",
        body: "The room is reacting to the broker notes.",
        score: 8,
        commentCount: 3,
        sourceCount: 2,
        highSignal: true,
        createdAt: new Date("2026-04-10T08:00:00Z"),
        updatedAt: new Date("2026-04-10T08:00:00Z"),
        lastActivityAt: new Date("2026-04-10T08:00:00Z"),
      },
    ]);

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/threads",
    );
    const response = await GET(request, {
      params: Promise.resolve({ stockCode: "CBA" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.stockCode).toBe("CBA");
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0]?.id).toBe("thread-1");
  });
});
