import {
  createPostgresCommunityStore,
  POSTGRES_COMMUNITY_COMMENT_LIST_LIMIT,
  POSTGRES_COMMUNITY_PULSE_LIST_LIMIT,
  POSTGRES_COMMUNITY_THREAD_LIST_LIMIT,
} from "../postgres-community";

type CapturedQuery = {
  text: string;
  values?: readonly unknown[];
};

function createDb(rowsByCall: Array<Record<string, unknown>[]>) {
  const queries: CapturedQuery[] = [];

  return {
    queries,
    db: {
      query: jest.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        return { rows: rowsByCall.shift() ?? [] };
      }),
    },
  };
}

describe("postgres community store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads active thread feeds with a bounded stock/status/activity query", async () => {
    const { db, queries } = createDb([
      [
        {
          id: "unsupported",
          stock_code: "BHP",
          type: "question",
          title: "What am I missing?",
          body: "Not seeing the thesis yet.",
          score: 12,
          comment_count: 1,
          source_count: 0,
          high_signal: false,
          created_at: new Date("2026-04-10T08:00:00Z"),
          updated_at: new Date("2026-04-10T08:00:00Z"),
          last_activity_at: new Date("2026-04-10T08:00:00Z"),
          status: "active",
          author_user_id: "u-1",
          author_display_name: "Ben",
          sources: [],
        },
        {
          id: "supported",
          stock_code: "BHP",
          type: "bull",
          title: "The capex case is tightening",
          body: "Three broker notes line up on the same catalyst.",
          score: 8,
          comment_count: 4,
          source_count: 3,
          high_signal: true,
          created_at: new Date("2026-04-10T08:00:00Z"),
          updated_at: new Date("2026-04-10T08:00:00Z"),
          last_activity_at: new Date("2026-04-10T08:00:00Z"),
          status: "active",
          author_user_id: "u-2",
          author_display_name: "Alice",
          sources: [{ label: "Broker note", url: "https://example.com" }],
        },
      ],
    ]);
    const store = createPostgresCommunityStore(() => db);

    const threads = await store.listCommunityThreads("bhp");

    expect(queries[0]?.text).toContain("FROM community_threads");
    expect(queries[0]?.text).toContain("stock_code = $1");
    expect(queries[0]?.text).toContain("status = 'active'");
    expect(queries[0]?.text).toContain("ORDER BY last_activity_at DESC, id DESC");
    expect(queries[0]?.values).toEqual(["BHP", POSTGRES_COMMUNITY_THREAD_LIST_LIMIT]);
    expect(threads[0]?.id).toBe("supported");
    expect(threads[0]?.author?.displayName).toBe("Alice");
    expect(threads).toHaveLength(2);
  });

  it("caps pulse, comments, and pulse replies with the expected query limits", async () => {
    const { db, queries } = createDb([[], [], []]);
    const store = createPostgresCommunityStore(() => db);

    await store.listCommunityPulseItems("lot");
    await store.listCommunityComments("lot", "thread-1");
    await store.listCommunityPulseReplies("lot", "pulse-1");

    expect(queries[0]?.text).toContain("FROM community_pulse");
    expect(queries[0]?.values).toEqual(["LOT", POSTGRES_COMMUNITY_PULSE_LIST_LIMIT]);
    expect(queries[1]?.text).toContain("FROM community_comments");
    expect(queries[1]?.values).toEqual(["LOT", "thread-1", POSTGRES_COMMUNITY_COMMENT_LIST_LIMIT]);
    expect(queries[2]?.text).toContain("FROM community_pulse_replies");
    expect(queries[2]?.values).toEqual(["LOT", "pulse-1", POSTGRES_COMMUNITY_COMMENT_LIST_LIMIT]);
  });

  it("upserts votes atomically on user and target identity", async () => {
    const { db, queries } = createDb([
      [
        {
          id: "vote-1",
          stock_code: "BHP",
          target_type: "thread",
          target_id: "thread-1",
          value: 1,
          user_id: "user-123",
          created_at: new Date("2026-04-10T08:00:00Z"),
          updated_at: new Date("2026-04-10T09:00:00Z"),
        },
      ],
    ]);
    const store = createPostgresCommunityStore(() => db);

    const vote = await store.createCommunityVote({
      stockCode: "bhp",
      targetType: "thread",
      targetId: "thread-1",
      value: 1,
      userId: "user-123",
    });

    expect(queries[0]?.text).toContain("INSERT INTO community_votes");
    expect(queries[0]?.text).toContain(
      "ON CONFLICT (user_id, target_type, target_id) DO UPDATE",
    );
    expect(queries[0]?.values).toEqual([
      expect.stringMatching(/^[a-f0-9]{40}$/),
      "BHP",
      "thread",
      "thread-1",
      1,
      "user-123",
    ]);
    expect(vote).toEqual(
      expect.objectContaining({
        id: "vote-1",
        stockCode: "BHP",
        targetType: "thread",
        targetId: "thread-1",
        value: 1,
        userId: "user-123",
      }),
    );
  });
}
);
