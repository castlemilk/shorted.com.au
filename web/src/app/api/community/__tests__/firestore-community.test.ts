import {
  createCommunityVote,
  getCommunityThread,
  getStockCommunitySummary,
  listCommunityComments,
  listCommunityPulseItems,
  listCommunityPulseReplies,
  listCommunityThreads,
} from "~/@/lib/community/firestore-community";
import { adminDb } from "~/@/lib/firebase-admin-db";

jest.mock("~/@/lib/firebase-admin-db", () => ({
  adminDb: {
    collection: jest.fn(),
  },
}));

type MockDocData = Record<string, unknown> & {
  createdAt?: Date;
  updatedAt?: Date;
  lastActivityAt?: Date;
};

function createDocSnapshot(id: string, data: MockDocData) {
  return {
    id,
    exists: true,
    data: () => data,
  };
}

function createCollectionHarness() {
  const summaryGet = jest.fn();
  const threadListGet = jest.fn();
  const threadDetailGet = jest.fn();
  const pulseDetailGet = jest.fn();
  const commentListGet = jest.fn();
  const pulseListGet = jest.fn();
  const pulseReplyListGet = jest.fn();

  const threadsQuery = {
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    get: threadListGet,
  };
  threadsQuery.where.mockReturnValue(threadsQuery);
  threadsQuery.orderBy.mockReturnValue(threadsQuery);
  threadsQuery.limit.mockReturnValue(threadsQuery);

  const commentsQuery = {
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    get: commentListGet,
  };
  commentsQuery.where.mockReturnValue(commentsQuery);
  commentsQuery.orderBy.mockReturnValue(commentsQuery);
  commentsQuery.limit.mockReturnValue(commentsQuery);

  const pulseQuery = {
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    get: pulseListGet,
  };
  pulseQuery.where.mockReturnValue(pulseQuery);
  pulseQuery.orderBy.mockReturnValue(pulseQuery);
  pulseQuery.limit.mockReturnValue(pulseQuery);

  const pulseRepliesQuery = {
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    get: pulseReplyListGet,
  };
  pulseRepliesQuery.where.mockReturnValue(pulseRepliesQuery);
  pulseRepliesQuery.orderBy.mockReturnValue(pulseRepliesQuery);
  pulseRepliesQuery.limit.mockReturnValue(pulseRepliesQuery);

  const threadsCollection = {
    where: jest.fn(() => threadsQuery),
    doc: jest.fn(() => ({
      get: threadDetailGet,
      collection: jest.fn((name: string) => {
        if (name === "comments") {
          return { where: jest.fn(() => commentsQuery) };
        }

        throw new Error(`Unexpected nested thread collection ${name}`);
      }),
    })),
  };

  const pulseCollection = {
    where: jest.fn(() => pulseQuery),
    doc: jest.fn(() => ({
      get: pulseDetailGet,
      collection: jest.fn((name: string) => {
        if (name === "replies") {
          return { where: jest.fn(() => pulseRepliesQuery) };
        }

        throw new Error(`Unexpected nested pulse collection ${name}`);
      }),
    })),
  };

  (adminDb.collection as jest.Mock).mockReturnValue({
    doc: jest.fn(() => ({
      get: summaryGet,
      collection: jest.fn((name: string) => {
        if (name === "threads") {
          return threadsCollection;
        }

        if (name === "pulse") {
          return pulseCollection;
        }

        throw new Error(`Unexpected collection ${name}`);
      }),
    })),
  });

  return {
    summaryGet,
    threadListGet,
    threadDetailGet,
    pulseDetailGet,
    threadsQuery,
    commentListGet,
    commentsQuery,
    pulseListGet,
    pulseQuery,
    pulseReplyListGet,
    pulseRepliesQuery,
  };
}

describe("firestore-community repository", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rebuilds summary text from current public content instead of a stale materialised title", async () => {
    const { summaryGet, threadListGet, pulseListGet } = createCollectionHarness();
    summaryGet.mockResolvedValue(createDocSnapshot("BHP", {
      headline: "Removed private title", threadCount: 6, pulseCount: 14,
      topThread: { id: "removed", title: "Removed private title" },
    }));
    threadListGet.mockResolvedValue({ docs: [createDocSnapshot("active", {
      stockCode: "BHP", title: "Current public question", status: "active",
    })] });
    pulseListGet.mockResolvedValue({ docs: [] });

    const summary = await getStockCommunitySummary("BHP");

    expect(summary.headline).toBe("Current public question");
    expect(summary.topThread?.id).toBe("active");
    expect(JSON.stringify(summary)).not.toContain("Removed private title");
    expect(summary.threadCount).toBe(1);
    expect(summary.pulseCount).toBe(0);
  });

  it("returns an empty summary when there is no current public content", async () => {
    const { summaryGet, threadListGet, pulseListGet } = createCollectionHarness();
    summaryGet.mockResolvedValue(createDocSnapshot("BHP", {
      headline: "Removed private title", threadCount: 1, pulseCount: 0,
    }));
    threadListGet.mockResolvedValue({ docs: [] });
    pulseListGet.mockResolvedValue({ docs: [] });

    const summary = await getStockCommunitySummary("BHP");

    expect(summary.threadCount).toBe(0);
    expect(summary.pulseCount).toBe(0);
    expect(summary.topThread).toBeUndefined();
    expect(summary.headline).not.toContain("Removed private title");
  });

  it("records bounded Firestore query cost when rebuilding a summary", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const { threadListGet, pulseListGet, threadsQuery, pulseQuery } = createCollectionHarness();
    threadListGet.mockResolvedValue({ docs: [] });
    pulseListGet.mockResolvedValue({ docs: [] });

    await getStockCommunitySummary("BHP");

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"type":"firestore_operation"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"collection":"stock_communities/threads"'));
    expect(threadsQuery.limit).toHaveBeenCalledWith(25);
    expect(pulseQuery.limit).toHaveBeenCalledWith(25);
    logSpy.mockRestore();
  });

  it("reads and ranks active community threads", async () => {
    const { threadListGet, threadsQuery } = createCollectionHarness();
    threadListGet.mockResolvedValue({
      docs: [
        createDocSnapshot("unsupported", {
          stockCode: "BHP",
          type: "question",
          title: "What am I missing?",
          body: "Not seeing the thesis yet.",
          score: 12,
          commentCount: 1,
          sourceCount: 0,
          highSignal: false,
          createdAt: new Date("2026-04-10T08:00:00Z"),
          updatedAt: new Date("2026-04-10T08:00:00Z"),
          lastActivityAt: new Date("2026-04-10T08:00:00Z"),
          status: "active",
        }),
        createDocSnapshot("supported", {
          stockCode: "BHP",
          type: "bull",
          title: "The capex case is tightening",
          body: "Three broker notes line up on the same catalyst.",
          score: 8,
          commentCount: 4,
          sourceCount: 3,
          highSignal: true,
          createdAt: new Date("2026-04-10T08:00:00Z"),
          updatedAt: new Date("2026-04-10T08:00:00Z"),
          lastActivityAt: new Date("2026-04-10T08:00:00Z"),
          status: "active",
        }),
      ],
    });

    const threads = await listCommunityThreads("BHP");

    expect(threadsQuery.limit).toHaveBeenCalledWith(25);
    expect(threads[0]?.id).toBe("supported");
    expect(threads).toHaveLength(2);
  });

  it("reads a single community thread detail", async () => {
    const { threadDetailGet } = createCollectionHarness();
    threadDetailGet.mockResolvedValue(
      createDocSnapshot("thread-123", {
        stockCode: "BHP",
        type: "catalyst",
        title: "Friday delivery numbers matter",
        body: "This is the line item the room is watching.",
        score: 5,
        commentCount: 2,
        sourceCount: 1,
        highSignal: false,
        createdAt: new Date("2026-04-10T08:00:00Z"),
        updatedAt: new Date("2026-04-10T09:00:00Z"),
        lastActivityAt: new Date("2026-04-10T09:00:00Z"),
        status: "active",
      }),
    );

    const thread = await getCommunityThread("BHP", "thread-123");

    expect(thread?.id).toBe("thread-123");
    expect(thread?.title).toBe("Friday delivery numbers matter");
  });

  it.each(["needs_review", "hidden", "deleted", undefined])(
    "withholds a %s thread from direct public reads",
    async (status) => {
      const { threadDetailGet } = createCollectionHarness();
      threadDetailGet.mockResolvedValue(createDocSnapshot("thread-1", {
        stockCode: "BHP", title: "Private evidence", status,
      }));

      expect(await getCommunityThread("BHP", "thread-1")).toBeNull();
    },
  );

  it.each(["needs_review", "hidden", "deleted", undefined])(
    "withholds active children when their parent is %s",
    async (status) => {
      const { threadDetailGet, pulseDetailGet, commentListGet, pulseReplyListGet } = createCollectionHarness();
      const parent = createDocSnapshot("parent-1", { stockCode: "BHP", status });
      threadDetailGet.mockResolvedValue(parent);
      pulseDetailGet.mockResolvedValue(parent);
      const activeReply = createDocSnapshot("reply-1", {
        stockCode: "BHP", threadId: "parent-1", body: "Private parent context", status: "active",
      });
      commentListGet.mockResolvedValue({ docs: [activeReply] });
      pulseReplyListGet.mockResolvedValue({ docs: [activeReply] });

      expect(await listCommunityComments("BHP", "parent-1")).toEqual([]);
      expect(await listCommunityPulseReplies("BHP", "parent-1")).toEqual([]);
      expect(commentListGet).not.toHaveBeenCalled();
      expect(pulseReplyListGet).not.toHaveBeenCalled();
    },
  );

  it("reads pulse items with recency-first ordering", async () => {
    const { pulseListGet, pulseQuery } = createCollectionHarness();
    pulseListGet.mockResolvedValue({
      docs: [
        createDocSnapshot("older", {
          stockCode: "BHP",
          body: "The desk was already positioned for this.",
          score: 12,
          replyCount: 4,
          createdAt: new Date("2026-04-10T08:00:00Z"),
          updatedAt: new Date("2026-04-10T08:00:00Z"),
          status: "active",
        }),
        createDocSnapshot("newer", {
          stockCode: "BHP",
          body: "Fresh broker downgrade out five minutes ago.",
          score: 1,
          replyCount: 0,
          createdAt: new Date("2026-04-11T08:00:00Z"),
          updatedAt: new Date("2026-04-11T08:00:00Z"),
          status: "active",
        }),
      ],
    });

    const pulse = await listCommunityPulseItems("BHP");

    expect(pulseQuery.orderBy).toHaveBeenCalledWith("createdAt", "desc");
    expect(pulseQuery.limit).toHaveBeenCalledWith(25);
    expect(pulse[0]?.id).toBe("newer");
    expect(pulse).toHaveLength(2);
  });

  it("caps comment and pulse reply reads", async () => {
    const {
      commentListGet,
      commentsQuery,
      pulseReplyListGet,
      pulseRepliesQuery,
      threadDetailGet,
      pulseDetailGet,
    } = createCollectionHarness();
    threadDetailGet.mockResolvedValue(createDocSnapshot("thread-1", { status: "active" }));
    pulseDetailGet.mockResolvedValue(createDocSnapshot("pulse-1", { status: "active" }));
    const commentDoc = createDocSnapshot("comment-1", {
      stockCode: "BHP",
      threadId: "thread-1",
      body: "Useful source.",
      score: 1,
      replyCount: 0,
      createdAt: new Date("2026-04-10T08:00:00Z"),
      updatedAt: new Date("2026-04-10T08:00:00Z"),
      status: "active",
    });
    commentListGet.mockResolvedValue({ docs: [commentDoc] });
    pulseReplyListGet.mockResolvedValue({ docs: [commentDoc] });

    await listCommunityComments("BHP", "thread-1");
    await listCommunityPulseReplies("BHP", "pulse-1");

    expect(commentsQuery.orderBy).toHaveBeenCalledWith("createdAt", "asc");
    expect(commentsQuery.limit).toHaveBeenCalledWith(50);
    expect(pulseRepliesQuery.orderBy).toHaveBeenCalledWith("createdAt", "asc");
    expect(pulseRepliesQuery.limit).toHaveBeenCalledWith(50);
  });

  it("upserts community votes by deterministic id instead of adding unbounded documents", async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    const doc = jest.fn(() => ({ set }));
    const add = jest.fn();
    (adminDb.collection as jest.Mock).mockReturnValue({ doc, add });

    const vote = await createCommunityVote({
      stockCode: "BHP",
      targetType: "thread",
      targetId: "thread-1",
      value: 1,
      userId: "user-123",
    });

    expect(adminDb.collection).toHaveBeenCalledWith("community_votes");
    expect(doc).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{40}$/));
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        stockCode: "BHP",
        targetType: "thread",
        targetId: "thread-1",
        value: 1,
        userId: "user-123",
      }),
      { merge: true },
    );
    expect(add).not.toHaveBeenCalled();
    expect(vote.id).toMatch(/^[a-f0-9]{40}$/);
  });
});
