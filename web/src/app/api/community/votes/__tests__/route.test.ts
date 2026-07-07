import { NextRequest } from "next/server";
import { POST } from "../route";
import { createCommunityVote } from "~/@/lib/community/community-repository";
import { auth } from "~/server/auth";

jest.mock("~/@/lib/community/community-repository", () => ({
  createCommunityVote: jest.fn(),
}));

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

describe("/api/community/votes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires authentication", async () => {
    (auth as jest.Mock).mockResolvedValue(null);

    const request = new NextRequest("http://localhost:3020/api/community/votes", {
      method: "POST",
      body: JSON.stringify({
        stockCode: "BHP",
        targetType: "thread",
        targetId: "thread-1",
        value: 1,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("validates the target type", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user-123" },
    });

    const request = new NextRequest("http://localhost:3020/api/community/votes", {
      method: "POST",
      body: JSON.stringify({
        stockCode: "BHP",
        targetType: "invalid",
        targetId: "thread-1",
        value: 1,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("passes the normalized vote payload to the repository", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user-123" },
    });
    (createCommunityVote as jest.Mock).mockResolvedValue({
      id: "vote-1",
    });

    const request = new NextRequest("http://localhost:3020/api/community/votes", {
      method: "POST",
      body: JSON.stringify({
        stockCode: " bhp ",
        targetType: "thread",
        targetId: "thread-1",
        value: 1,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(createCommunityVote).toHaveBeenCalledWith({
      stockCode: "BHP",
      targetType: "thread",
      targetId: "thread-1",
      value: 1,
      userId: "user-123",
    });
  });
});
