import { revalidateTag, unstable_noStore } from "next/cache";
import {
  COMMUNITY_PUBLIC_READ_CACHE_CONTROL,
  getCachedCommunityComments,
  getCachedCommunityPulseItems,
  getCachedCommunityPulseReplies,
  getCachedCommunityThread,
  getCachedCommunityThreads,
  revalidateCommunityCacheTags,
} from "../community-activity-cache";
import {
  getCommunityThread,
  listCommunityComments,
  listCommunityPulseItems,
  listCommunityPulseReplies,
  listCommunityThreads,
} from "../community-repository";

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
jest.mock("../community-repository", () => ({
  getCommunityThread: jest.fn(),
  listCommunityComments: jest.fn(),
  listCommunityPulseItems: jest.fn(),
  listCommunityPulseReplies: jest.fn(),
  listCommunityThreads: jest.fn(),
}));

describe("community public read freshness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDataCache.clear();
  });

  it.each([
    {
      name: "threads",
      read: () => getCachedCommunityThreads("bhp"),
      source: listCommunityThreads,
      visible: [{ id: "thread-1", status: "active" }],
      removed: [],
    },
    {
      name: "pulse",
      read: () => getCachedCommunityPulseItems("bhp"),
      source: listCommunityPulseItems,
      visible: [{ id: "pulse-1", status: "active" }],
      removed: [],
    },
    {
      name: "thread detail",
      read: () => getCachedCommunityThread("bhp", " thread-1 "),
      source: getCommunityThread,
      visible: { id: "thread-1", status: "active" },
      removed: null,
    },
    {
      name: "comments",
      read: () => getCachedCommunityComments("bhp", " thread-1 "),
      source: listCommunityComments,
      visible: [{ id: "comment-1", status: "active" }],
      removed: [],
    },
    {
      name: "pulse replies",
      read: () => getCachedCommunityPulseReplies("bhp", " pulse-1 "),
      source: listCommunityPulseReplies,
      visible: [{ id: "reply-1", status: "active" }],
      removed: [],
    },
  ])(
    "does not replay cached $name after moderation removes it",
    async ({ read, source, visible, removed }) => {
      (source as jest.Mock).mockResolvedValue(visible);
      expect(await read()).toEqual(visible);
      (source as jest.Mock).mockResolvedValue(removed);
      expect(await read()).toEqual(removed);
      expect(unstable_noStore).toHaveBeenCalled();
      expect((source as jest.Mock).mock.calls[0]?.[0]).toBe("BHP");
      if ((source as jest.Mock).mock.calls[0]?.length > 1) {
        expect((source as jest.Mock).mock.calls[0]?.[1]).not.toMatch(/^\s|\s$/);
      }
    },
  );

  it("forbids CDN/browser reuse of moderated public content", () => {
    expect(COMMUNITY_PUBLIC_READ_CACHE_CONTROL).toBe("no-store");
  });

  it("keeps explicit tag invalidation available to mutation callers", () => {
    revalidateCommunityCacheTags([
      "community-threads:BHP",
      "community-pulse:BHP",
    ]);
    expect(revalidateTag).toHaveBeenCalledWith("community-threads:BHP");
    expect(revalidateTag).toHaveBeenCalledWith("community-pulse:BHP");
  });
});
