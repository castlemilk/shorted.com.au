import {
  COMMUNITY_MEMBER_NAME,
  communityAuthorSnapshot,
  toPublicCommunityComment,
  toPublicCommunityPulseItem,
  toPublicCommunityThread,
} from "../public-content";
import { type CommunityThread } from "~/@/types/community";

describe("community public identity", () => {
  it.each([
    undefined,
    null,
    "",
    "   ",
    "private@example.test",
    "Alex <private@example.test>",
    "private＠example.test",
    "<img src=x onerror=alert(1)>",
    "Alex\u202eAdmin",
    "Alex\nAdministrator",
    "https://provider.example/private-account",
    "x".repeat(81),
    "private-firebase-uid",
  ])(
    "uses a neutral label for an absent, private or unsafe name: %s",
    (name) => {
      expect(
        communityAuthorSnapshot({ id: "private-firebase-uid", name }),
      ).toEqual({
        userId: "private-firebase-uid",
        displayName: COMMUNITY_MEMBER_NAME,
      });
    },
  );

  it("preserves plain Unicode names without using provider metadata", () => {
    const sessionUser = {
      id: "private-firebase-uid",
      name: "  Zoë   O’Connor  ",
      email: "private@example.test",
      image: "https://provider.example/private-avatar",
    };
    expect(communityAuthorSnapshot(sessionUser)).toEqual({
      userId: "private-firebase-uid",
      displayName: "Zoë O’Connor",
    });
  });

  const thread: CommunityThread = {
    id: "thread-1",
    stockCode: "CBA",
    type: "question",
    title: "What changed?",
    body: "Question body",
    score: 1,
    commentCount: 2,
    sourceCount: 1,
    highSignal: false,
    createdAt: new Date("2026-11-10T00:00:00Z"),
    updatedAt: new Date("2026-11-10T00:00:00Z"),
    lastActivityAt: new Date("2026-11-10T00:00:00Z"),
    status: "active",
    author: {
      userId: "private-firebase-uid",
      displayName: "Alex",
      handle: "private-handle",
      avatarUrl: "https://provider.example/private-avatar",
      trustScore: 12,
    },
    sources: [{ label: "Filing", url: "https://example.test/filing" }],
  };

  it("projects explicit public fields and leaves private history untouched", () => {
    const stored = { ...thread, privateEmail: "private@example.test" };
    const output = toPublicCommunityThread(stored);
    expect(output.author).toEqual({ displayName: "Alex" });
    expect(output.id).toBe(thread.id);
    expect(output.sources).toEqual(thread.sources);
    expect(output).not.toHaveProperty("privateEmail");
    expect(stored.author).toEqual(thread.author);
    expect(toPublicCommunityThread(output)).toEqual(output);
  });

  it("handles missing authors without inventing ownership", () => {
    expect(
      toPublicCommunityThread({ ...thread, author: undefined }).author,
    ).toBeUndefined();
  });

  it("sanitises legacy email labels and does not change comment/pulse target IDs", () => {
    const legacy = {
      ...thread,
      threadId: thread.id,
      replyCount: 0,
      author: { ...thread.author!, displayName: "private@example.test" },
    };
    const comment = toPublicCommunityComment(legacy);
    const pulse = toPublicCommunityPulseItem(legacy);
    expect(comment).toMatchObject({
      id: legacy.id,
      threadId: legacy.threadId,
      stockCode: "CBA",
      author: { displayName: COMMUNITY_MEMBER_NAME },
    });
    expect(pulse).toMatchObject({
      id: legacy.id,
      stockCode: "CBA",
      author: { displayName: COMMUNITY_MEMBER_NAME },
    });
    expect(JSON.stringify([comment, pulse])).not.toMatch(/private-|private@/);
    expect(legacy.author.displayName).toBe("private@example.test");
  });
});
