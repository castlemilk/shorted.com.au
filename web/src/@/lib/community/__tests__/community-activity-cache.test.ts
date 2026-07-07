import { revalidateTag, unstable_cache } from "next/cache";
import {
  COMMUNITY_PUBLIC_READ_CACHE_SECONDS,
  communityPulseCacheTag,
  communityPulseRepliesCacheTag,
  communityThreadCacheTag,
  communityThreadCommentsCacheTag,
  communityThreadsCacheTag,
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

jest.mock("next/cache", () => ({
  revalidateTag: jest.fn(),
  unstable_cache: jest.fn((loader) => loader),
}));

jest.mock("../community-repository", () => ({
  getCommunityThread: jest.fn(),
  listCommunityComments: jest.fn(),
  listCommunityPulseItems: jest.fn(),
  listCommunityPulseReplies: jest.fn(),
  listCommunityThreads: jest.fn(),
}));

describe("community activity cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("wraps community thread lists in a tagged public data cache", async () => {
    (listCommunityThreads as jest.Mock).mockResolvedValue([]);

    await getCachedCommunityThreads("bhp");

    expect(listCommunityThreads).toHaveBeenCalledWith("BHP");
    expect(communityThreadsCacheTag("bhp")).toBe("community-threads:BHP");
    expect(unstable_cache).toHaveBeenCalledWith(
      expect.any(Function),
      ["community-threads", "BHP"],
      {
        revalidate: COMMUNITY_PUBLIC_READ_CACHE_SECONDS,
        tags: ["community-threads:BHP"],
      },
    );
  });

  it("wraps pulse lists, thread details, comments, and replies with scoped tags", async () => {
    (listCommunityPulseItems as jest.Mock).mockResolvedValue([]);
    (getCommunityThread as jest.Mock).mockResolvedValue(null);
    (listCommunityComments as jest.Mock).mockResolvedValue([]);
    (listCommunityPulseReplies as jest.Mock).mockResolvedValue([]);

    await getCachedCommunityPulseItems("bhp");
    await getCachedCommunityThread("bhp", "thread-1");
    await getCachedCommunityComments("bhp", "thread-1");
    await getCachedCommunityPulseReplies("bhp", "pulse-1");

    expect(communityPulseCacheTag("bhp")).toBe("community-pulse:BHP");
    expect(communityThreadCacheTag("bhp", "thread-1")).toBe(
      "community-thread:BHP:thread-1",
    );
    expect(communityThreadCommentsCacheTag("bhp", "thread-1")).toBe(
      "community-thread-comments:BHP:thread-1",
    );
    expect(communityPulseRepliesCacheTag("bhp", "pulse-1")).toBe(
      "community-pulse-replies:BHP:pulse-1",
    );
    expect(unstable_cache).toHaveBeenCalledTimes(4);
  });

  it("revalidates requested community cache tags", () => {
    revalidateCommunityCacheTags(["community-threads:BHP", "community-pulse:BHP"]);

    expect(revalidateTag).toHaveBeenCalledWith("community-threads:BHP");
    expect(revalidateTag).toHaveBeenCalledWith("community-pulse:BHP");
  });
});
