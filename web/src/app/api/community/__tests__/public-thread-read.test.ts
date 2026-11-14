import { NextRequest } from "next/server";
import { GET } from "../[stockCode]/threads/[threadId]/route";
import { getCommunityThread } from "~/@/lib/community/community-repository";

const mockDataCache = new Map<string, unknown>();
jest.mock("next/cache", () => ({
  revalidateTag: jest.fn(),
  unstable_noStore: jest.fn(),
  unstable_cache: jest.fn((loader, key) => async () => {
    const cacheKey = JSON.stringify(key);
    if (!mockDataCache.has(cacheKey))
      mockDataCache.set(cacheKey, await loader());
    return mockDataCache.get(cacheKey);
  }),
}));
jest.mock("~/@/lib/community/community-repository", () => ({
  getCommunityThread: jest.fn(),
}));

describe("public thread API through the read cache boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDataCache.clear();
  });

  it("returns no-store public data, then a no-store 404 after the store withdraws it", async () => {
    const request = new NextRequest(
      "http://localhost:3020/api/community/BHP/threads/thread-1",
    );
    const context = {
      params: Promise.resolve({ stockCode: "BHP", threadId: "thread-1" }),
    };
    (getCommunityThread as jest.Mock).mockResolvedValue({
      id: "thread-1",
      stockCode: "BHP",
      title: "Research question",
      body: "Previously public evidence",
      status: "active",
    });

    const visible = await GET(request, context);
    expect(visible.status).toBe(200);
    expect(visible.headers.get("Cache-Control")).toBe("no-store");
    expect((await visible.json()).thread.body).toBe(
      "Previously public evidence",
    );

    (getCommunityThread as jest.Mock).mockResolvedValue(null);
    const withdrawn = await GET(request, context);
    expect(withdrawn.status).toBe(404);
    expect(withdrawn.headers.get("Cache-Control")).toBe("no-store");
    expect(await withdrawn.json()).toEqual({ error: "Thread not found" });
  });
});
