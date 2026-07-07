import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { createCommunityThread } from "~/@/lib/community/community-repository";
import {
  getCachedCommunityThreads,
  revalidateCommunityCacheTags,
} from "~/@/lib/community/community-activity-cache";
import { auth } from "~/server/auth";

jest.mock("~/@/lib/community/community-repository", () => ({
  createCommunityThread: jest.fn(),
}));

jest.mock("~/@/lib/community/community-activity-cache", () => ({
  COMMUNITY_PUBLIC_READ_CACHE_CONTROL:
    "public, s-maxage=60, stale-while-revalidate=300",
  communityThreadsCacheTag: jest.fn(
    (stockCode: string) => `community-threads:${stockCode.toUpperCase()}`,
  ),
  getCachedCommunityThreads: jest.fn(),
  revalidateCommunityCacheTags: jest.fn(),
}));

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

describe("/api/community/[stockCode]/threads", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the public thread list payload", async () => {
    (getCachedCommunityThreads as jest.Mock).mockResolvedValue([
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
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=60");
    expect(data.stockCode).toBe("CBA");
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0]?.id).toBe("thread-1");
  });

  it("returns an empty public thread list when Firestore credentials are unavailable", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    (getCachedCommunityThreads as jest.Mock).mockRejectedValue(
      Object.assign(
        new Error("16 UNAUTHENTICATED: Request had invalid authentication credentials."),
        { code: 16 },
      ),
    );

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/threads",
    );
    const response = await GET(request, {
      params: Promise.resolve({ stockCode: "CBA" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=60");
    expect(data.stockCode).toBe("CBA");
    expect(data.threads).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"route":"threads"'),
    );

    warn.mockRestore();
  });

  it("returns an empty public thread list while Firestore indexes are unavailable", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    (getCachedCommunityThreads as jest.Mock).mockRejectedValue(
      Object.assign(
        new Error("9 FAILED_PRECONDITION: The query requires an index."),
        { code: 9 },
      ),
    );

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/threads",
    );
    const response = await GET(request, {
      params: Promise.resolve({ stockCode: "CBA" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.threads).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"route":"threads"'),
    );

    warn.mockRestore();
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
    expect(revalidateCommunityCacheTags).toHaveBeenCalledWith([
      "community-threads:CBA",
    ]);
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
