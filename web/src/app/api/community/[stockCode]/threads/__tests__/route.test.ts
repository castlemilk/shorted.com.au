import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import {
  createCommunityThread,
  listCommunityThreads,
} from "~/@/lib/community/firestore-community";
import { auth } from "~/server/auth";

jest.mock("~/@/lib/community/firestore-community", () => ({
  listCommunityThreads: jest.fn(),
  createCommunityThread: jest.fn(),
}));

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
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

  it("rejects unauthenticated thread creation", async () => {
    (auth as jest.Mock).mockResolvedValue(null);

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/threads",
      {
        method: "POST",
        body: JSON.stringify({
          type: "bull",
          title: "Capital discipline is improving",
          body: "Three broker notes point to the same setup.",
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ stockCode: "CBA" }),
    });

    expect(response.status).toBe(401);
  });

  it("creates a moderated thread for authenticated users", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: {
        id: "user-123",
        name: "Test User",
        email: "test@example.com",
      },
    });
    (createCommunityThread as jest.Mock).mockResolvedValue({
      id: "thread-2",
      stockCode: "CBA",
      type: "bull",
      title: "join my discord",
      body: "buy now",
      score: 0,
      commentCount: 0,
      sourceCount: 0,
      highSignal: false,
      createdAt: new Date("2026-04-11T08:00:00Z"),
      updatedAt: new Date("2026-04-11T08:00:00Z"),
      lastActivityAt: new Date("2026-04-11T08:00:00Z"),
      status: "needs_review",
    });

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/threads",
      {
        method: "POST",
        body: JSON.stringify({
          type: "bull",
          title: "  join my discord  ",
          body: "  buy now  ",
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ stockCode: "CBA" }),
    });

    expect(response.status).toBe(201);
    expect(createCommunityThread).toHaveBeenCalledWith(
      expect.objectContaining({
        stockCode: "CBA",
        type: "bull",
        title: "join my discord",
        body: "buy now",
        status: "needs_review",
      }),
    );
  });
});
