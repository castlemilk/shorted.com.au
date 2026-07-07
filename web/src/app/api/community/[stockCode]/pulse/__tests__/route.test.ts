import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { createCommunityPulseItem } from "~/@/lib/community/community-repository";
import {
  getCachedCommunityPulseItems,
  revalidateCommunityCacheTags,
} from "~/@/lib/community/community-activity-cache";
import { auth } from "~/server/auth";

jest.mock("~/@/lib/community/community-repository", () => ({
  createCommunityPulseItem: jest.fn(),
}));

jest.mock("~/@/lib/community/community-activity-cache", () => ({
  COMMUNITY_PUBLIC_READ_CACHE_CONTROL:
    "public, s-maxage=60, stale-while-revalidate=300",
  communityPulseCacheTag: jest.fn(
    (stockCode: string) => `community-pulse:${stockCode.toUpperCase()}`,
  ),
  getCachedCommunityPulseItems: jest.fn(),
  revalidateCommunityCacheTags: jest.fn(),
}));

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

describe("/api/community/[stockCode]/pulse", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the public pulse payload", async () => {
    (getCachedCommunityPulseItems as jest.Mock).mockResolvedValue([
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
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=60");
    expect(data.stockCode).toBe("CBA");
    expect(data.pulse).toHaveLength(1);
    expect(data.pulse[0]?.id).toBe("pulse-1");
  });

  it("returns an empty public pulse list when Firestore credentials are unavailable", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    (getCachedCommunityPulseItems as jest.Mock).mockRejectedValue(
      Object.assign(
        new Error("16 UNAUTHENTICATED: Request had invalid authentication credentials."),
        { code: 16 },
      ),
    );

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/pulse",
    );
    const response = await GET(request, {
      params: Promise.resolve({ stockCode: "CBA" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=60");
    expect(data.stockCode).toBe("CBA");
    expect(data.pulse).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"route":"pulse"'),
    );

    warn.mockRestore();
  });

  it("returns an empty public pulse list while Firestore indexes are unavailable", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    (getCachedCommunityPulseItems as jest.Mock).mockRejectedValue(
      Object.assign(
        new Error("9 FAILED_PRECONDITION: The query requires an index."),
        { code: 9 },
      ),
    );

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/pulse",
    );
    const response = await GET(request, {
      params: Promise.resolve({ stockCode: "CBA" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.pulse).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"route":"pulse"'),
    );

    warn.mockRestore();
  });

  it("rejects invalid pulse content", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: {
        id: "user-123",
      },
    });

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/pulse",
      {
        method: "POST",
        body: JSON.stringify({ body: "   " }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ stockCode: "CBA" }),
    });

    expect(response.status).toBe(400);
  });

  it("creates an active pulse item for authenticated users", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: {
        id: "user-123",
        name: "Test User",
        email: "test@example.com",
      },
    });
    (createCommunityPulseItem as jest.Mock).mockResolvedValue({
      id: "pulse-2",
      stockCode: "CBA",
      body: "Fresh broker downgrade just hit the tape.",
      score: 0,
      replyCount: 0,
      createdAt: new Date("2026-04-11T08:00:00Z"),
      updatedAt: new Date("2026-04-11T08:00:00Z"),
      status: "active",
    });

    const request = new NextRequest(
      "http://localhost:3020/api/community/CBA/pulse",
      {
        method: "POST",
        body: JSON.stringify({
          body: "  Fresh broker downgrade just hit the tape.  ",
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ stockCode: "CBA" }),
    });

    expect(response.status).toBe(201);
    expect(revalidateCommunityCacheTags).toHaveBeenCalledWith([
      "community-pulse:CBA",
    ]);
    expect(createCommunityPulseItem).toHaveBeenCalledWith(
      expect.objectContaining({
        stockCode: "CBA",
        body: "Fresh broker downgrade just hit the tape.",
        status: "active",
      }),
    );
  });
});
