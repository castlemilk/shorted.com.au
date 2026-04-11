import { NextRequest } from "next/server";
import { POST } from "../route";
import { createCommunityReport } from "~/@/lib/community/firestore-community";
import { auth } from "~/server/auth";

jest.mock("~/@/lib/community/firestore-community", () => ({
  createCommunityReport: jest.fn(),
}));

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

describe("/api/community/reports", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires authentication", async () => {
    (auth as jest.Mock).mockResolvedValue(null);

    const request = new NextRequest(
      "http://localhost:3020/api/community/reports",
      {
        method: "POST",
        body: JSON.stringify({
          stockCode: "BHP",
          targetType: "thread",
          targetId: "thread-1",
          reason: "spam",
        }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("validates the target type", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user-123" },
    });

    const request = new NextRequest(
      "http://localhost:3020/api/community/reports",
      {
        method: "POST",
        body: JSON.stringify({
          stockCode: "BHP",
          targetType: "invalid",
          targetId: "thread-1",
          reason: "spam",
        }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("stores a normalized report payload", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user-123" },
    });
    (createCommunityReport as jest.Mock).mockResolvedValue({
      id: "report-1",
    });

    const request = new NextRequest(
      "http://localhost:3020/api/community/reports",
      {
        method: "POST",
        body: JSON.stringify({
          stockCode: " bhp ",
          targetType: "thread",
          targetId: "thread-1",
          reason: "spam",
          details: "Repeated pump messages",
        }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(createCommunityReport).toHaveBeenCalledWith({
      stockCode: "BHP",
      targetType: "thread",
      targetId: "thread-1",
      reason: "spam",
      details: "Repeated pump messages",
      userId: "user-123",
    });
  });
});
