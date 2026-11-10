import { NextRequest } from "next/server";
import {
  GET as getThreads,
  POST as postThread,
} from "../[stockCode]/threads/route";
import { GET as getThread } from "../[stockCode]/threads/[threadId]/route";
import {
  GET as getComments,
  POST as postComment,
} from "../[stockCode]/threads/[threadId]/comments/route";
import { GET as getPulse, POST as postPulse } from "../[stockCode]/pulse/route";
import {
  GET as getReplies,
  POST as postReply,
} from "../[stockCode]/pulse/[pulseId]/replies/route";
import * as repository from "~/@/lib/community/community-repository";
import * as activity from "~/@/lib/community/community-activity-cache";
import { auth } from "~/server/auth";

jest.mock("~/@/lib/community/community-repository", () => ({
  createCommunityThread: jest.fn(),
  createCommunityComment: jest.fn(),
  createCommunityPulseItem: jest.fn(),
  createCommunityPulseReply: jest.fn(),
}));
jest.mock("~/@/lib/community/community-activity-cache", () => ({
  COMMUNITY_PUBLIC_READ_CACHE_CONTROL: "no-store",
  getCachedCommunityThreads: jest.fn(),
  getCachedCommunityThread: jest.fn(),
  getCachedCommunityComments: jest.fn(),
  getCachedCommunityPulseItems: jest.fn(),
  getCachedCommunityPulseReplies: jest.fn(),
  communityThreadsCacheTag: jest.fn(),
  communityThreadCommentsCacheTag: jest.fn(),
  communityPulseCacheTag: jest.fn(),
  communityPulseRepliesCacheTag: jest.fn(),
  revalidateCommunityCacheTags: jest.fn(),
}));
jest.mock("~/server/auth", () => ({ auth: jest.fn() }));
jest.mock("~/@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue({ success: true }),
}));

const privateUserId = "private-firebase-uid";
const privateEmail = "private.address@example.test";
const privateAvatar =
  "https://provider.example/avatar/private-account-id?token=secret";
const storedItem = {
  id: "content-1",
  stockCode: "CBA",
  threadId: "thread-1",
  type: "question",
  title: "What changed in the filing?",
  body: "How does the denominator affect this figure?",
  score: 2,
  commentCount: 1,
  replyCount: 1,
  sourceCount: 0,
  highSignal: false,
  createdAt: new Date("2026-11-10T00:00:00Z"),
  updatedAt: new Date("2026-11-10T00:00:00Z"),
  lastActivityAt: new Date("2026-11-10T00:00:00Z"),
  status: "active",
  author: {
    userId: privateUserId,
    displayName: privateEmail,
    email: privateEmail,
    handle: "private-provider-handle",
    avatarUrl: privateAvatar,
    trustScore: 999,
  },
};

const context = () => ({
  params: Promise.resolve({
    stockCode: "CBA",
    threadId: "thread-1",
    pulseId: "pulse-1",
  }),
});
const readCases = [
  {
    name: "thread list",
    get: getThreads,
    load: activity.getCachedCommunityThreads,
    key: "threads",
    list: true,
  },
  {
    name: "thread detail",
    get: getThread,
    load: activity.getCachedCommunityThread,
    key: "thread",
    list: false,
  },
  {
    name: "comments",
    get: getComments,
    load: activity.getCachedCommunityComments,
    key: "comments",
    list: true,
  },
  {
    name: "pulse list",
    get: getPulse,
    load: activity.getCachedCommunityPulseItems,
    key: "pulse",
    list: true,
  },
  {
    name: "pulse replies",
    get: getReplies,
    load: activity.getCachedCommunityPulseReplies,
    key: "replies",
    list: true,
  },
];
const writeCases = [
  {
    name: "thread",
    post: postThread,
    create: repository.createCommunityThread,
    key: "thread",
  },
  {
    name: "comment",
    post: postComment,
    create: repository.createCommunityComment,
    key: "comment",
  },
  {
    name: "pulse",
    post: postPulse,
    create: repository.createCommunityPulseItem,
    key: "pulse",
  },
  {
    name: "pulse reply",
    post: postReply,
    create: repository.createCommunityPulseReply,
    key: "reply",
  },
];

function expectPublicAuthor(item: { author: unknown }, expectedName: string) {
  expect(item.author).toEqual({ displayName: expectedName });
  const payload = JSON.stringify(item);
  for (const privateValue of [
    privateUserId,
    privateEmail,
    privateAvatar,
    "private-provider-handle",
  ]) {
    expect(payload).not.toContain(privateValue);
  }
}

describe("community response identity boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(readCases)(
    "sanitises legacy identity snapshots in $name",
    async ({ get, load, key, list }) => {
      (load as jest.Mock).mockResolvedValue(list ? [storedItem] : storedItem);
      const response = await get(
        new NextRequest("http://localhost:3020/api/community/CBA"),
        context(),
      );
      const payload = await response.json();
      expect(response.status).toBe(200);
      expectPublicAuthor(
        list ? payload[key][0] : payload[key],
        "Community member",
      );
      // Public serialization must not rewrite the private historical record.
      expect(storedItem.author.userId).toBe(privateUserId);
      expect(storedItem.author.displayName).toBe(privateEmail);
    },
  );

  it.each(writeCases)(
    "keeps $name ownership private without an email-name fallback",
    async ({ post, create, key }) => {
      (auth as jest.Mock).mockResolvedValue({
        user: { id: privateUserId, name: null, email: privateEmail },
      });
      (create as jest.Mock).mockImplementation(async (input) => ({
        ...storedItem,
        ...input,
      }));
      const response = await post(
        new NextRequest("http://localhost:3020/api/community/CBA", {
          method: "POST",
          body: JSON.stringify({
            type: "question",
            title: storedItem.title,
            body: storedItem.body,
          }),
        }),
        context(),
      );
      const payload = await response.json();
      expect(response.status).toBe(201);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          author: { userId: privateUserId, displayName: "Community member" },
        }),
      );
      expectPublicAuthor(payload[key], "Community member");
      expect(payload[key].id).toBe("content-1");
    },
  );

  it.each(writeCases)(
    "sanitises $name author-local moderation previews",
    async ({ post, create, key }) => {
      (auth as jest.Mock).mockResolvedValue({
        user: { id: privateUserId, name: "Alex", email: privateEmail },
      });
      (create as jest.Mock).mockResolvedValue({
        ...storedItem,
        status: "needs_review",
        author: { ...storedItem.author, displayName: "Alex" },
      });
      const response = await post(
        new NextRequest("http://localhost:3020/api/community/CBA", {
          method: "POST",
          body: JSON.stringify({
            type: "question",
            title: storedItem.title,
            body: "join my discord",
          }),
        }),
        context(),
      );
      const payload = await response.json();
      expect(response.status).toBe(201);
      expect(payload[key].status).toBe("needs_review");
      expectPublicAuthor(payload[key], "Alex");
    },
  );
});
