import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { createCommunityComment } from "~/@/lib/community/community-repository";
import {
  getCachedCommunityComments,
  revalidateCommunityCacheTags,
} from "~/@/lib/community/community-activity-cache";
import { auth } from "~/server/auth";

jest.mock("~/@/lib/community/community-repository", () => ({
  createCommunityComment: jest.fn(),
}));

jest.mock("~/@/lib/community/community-activity-cache", () => ({
  COMMUNITY_PUBLIC_READ_CACHE_CONTROL:
    "public, s-maxage=60, stale-while-revalidate=300",
  communityThreadCommentsCacheTag: jest.fn(
    (stockCode: string, threadId: string) =>
      `community-thread-comments:${stockCode.toUpperCase()}:${threadId}`,
  ),
  getCachedCommunityComments: jest.fn(),
  revalidateCommunityCacheTags: jest.fn(),
}));

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

describe("/api/community/[stockCode]/threads/[threadId]/comments", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns cached public comments", async () => {
    (getCachedCommunityComments as jest.Mock).mockResolvedValue([
      {
        id: "comment-1",
        stockCode: "CBA",
        threadId: "thread-1",
        body: "Useful source.",
        score: 1,
        replyCount: 0,
        createdAt: new Date("2026-04-11T08:00:00Z"),
        updatedAt: new Date("2026-04-11T08:00:00Z"),
      },
    ]);

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/threads/thread-1/comments",
    );
    const response = await GET(request, {
      params: Promise.resolve({ stockCode: "CBA", threadId: "thread-1" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=60");
    expect(data.comments).toHaveLength(1);
  });

  it("rejects unauthenticated comment creation", async () => {
    (auth as jest.Mock).mockResolvedValue(null);

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/threads/thread-1/comments",
      {
        method: "POST",
        body: JSON.stringify({
          body: "The catalyst timing is tighter than the market thinks.",
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ stockCode: "CBA", threadId: "thread-1" }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects invalid comment content", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: {
        id: "user-123",
      },
    });

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/threads/thread-1/comments",
      {
        method: "POST",
        body: JSON.stringify({ body: " " }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ stockCode: "CBA", threadId: "thread-1" }),
    });

    expect(response.status).toBe(400);
  });

  it("creates a moderated comment for authenticated users", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: {
        id: "user-123",
        name: "Test User",
        email: "test@example.com",
      },
    });
    (createCommunityComment as jest.Mock).mockResolvedValue({
      id: "comment-1",
      stockCode: "CBA",
      threadId: "thread-1",
      body: "The catalyst timing is tighter than the market thinks.",
      score: 0,
      replyCount: 0,
      createdAt: new Date("2026-04-11T08:00:00Z"),
      updatedAt: new Date("2026-04-11T08:00:00Z"),
      status: "active",
    });

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/threads/thread-1/comments",
      {
        method: "POST",
        body: JSON.stringify({
          body: "  The catalyst timing is tighter than the market thinks.  ",
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ stockCode: "CBA", threadId: "thread-1" }),
    });

    expect(response.status).toBe(201);
    expect(revalidateCommunityCacheTags).toHaveBeenCalledWith([
      "community-thread-comments:CBA:thread-1",
    ]);
    expect(createCommunityComment).toHaveBeenCalledWith(
      expect.objectContaining({
        stockCode: "CBA",
        threadId: "thread-1",
        body: "The catalyst timing is tighter than the market thinks.",
        status: "active",
      }),
    );
  });
});
