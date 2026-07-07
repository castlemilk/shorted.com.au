import {
  backfillCommunityToPostgres,
  type CommunityBackfillDb,
  type FirestoreCollectionLike,
  type FirestoreDbLike,
} from "./community-backfill-postgres";

type DocInput = {
  id: string;
  data?: Record<string, unknown>;
  collections?: Record<string, DocInput[]>;
};

function createFirestore(collections: Record<string, DocInput[]>): FirestoreDbLike {
  return {
    collection(name: string) {
      return createCollection(collections[name] ?? []);
    },
  };
}

function createCollection(docs: DocInput[]): FirestoreCollectionLike {
  return {
    async get() {
      return {
        docs: docs.map((doc) => ({
          id: doc.id,
          data: () => doc.data ?? {},
          ref: {
            collection(name: string) {
              return createCollection(doc.collections?.[name] ?? []);
            },
          },
        })),
      };
    },
  };
}

function createDb(): CommunityBackfillDb & {
  queries: Array<{ text: string; values?: readonly unknown[] }>;
} {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  return {
    queries,
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      return { rows: [] };
    },
  };
}

describe("community Firestore to Postgres backfill", () => {
  it("dry-runs without writing to Postgres", async () => {
    const firestore = createFirestore({
      stock_communities: [
        {
          id: "BHP",
          collections: {
            threads: [
              {
                id: "thread-1",
                data: {
                  stockCode: "BHP",
                  type: "bull",
                  title: "Thread",
                  body: "Body",
                  status: "active",
                  createdAt: new Date("2026-04-10T08:00:00Z"),
                },
              },
            ],
            pulse: [],
          },
        },
      ],
    });
    const db = createDb();

    const stats = await backfillCommunityToPostgres({
      firestore,
      db,
      apply: false,
      logger: noopLogger(),
    });

    expect(stats.threadsRead).toBe(1);
    expect(stats.threadsWritten).toBe(0);
    expect(db.queries).toEqual([]);
  });

  it("preserves Firestore thread, comment, pulse, and reply ids during apply", async () => {
    const firestore = createFirestore({
      stock_communities: [
        {
          id: "lot",
          collections: {
            threads: [
              {
                id: "thread-1",
                data: {
                  stockCode: "LOT",
                  type: "question",
                  title: "What changed?",
                  body: "Trying to understand the catalyst.",
                  sourceCount: 1,
                  sources: [{ label: "ASX", url: "https://example.com" }],
                  author: { userId: "u-1", displayName: "Ben" },
                  status: "active",
                  createdAt: new Date("2026-04-10T08:00:00Z"),
                  updatedAt: new Date("2026-04-10T08:05:00Z"),
                  lastActivityAt: new Date("2026-04-10T08:06:00Z"),
                },
                collections: {
                  comments: [
                    {
                      id: "comment-1",
                      data: {
                        stockCode: "LOT",
                        threadId: "thread-1",
                        body: "Useful source.",
                        author: { userId: "u-2", displayName: "Alice" },
                        status: "active",
                        createdAt: new Date("2026-04-10T09:00:00Z"),
                      },
                    },
                  ],
                },
              },
            ],
            pulse: [
              {
                id: "pulse-1",
                data: {
                  stockCode: "LOT",
                  body: "Fresh update.",
                  status: "active",
                  createdAt: new Date("2026-04-11T08:00:00Z"),
                },
                collections: {
                  replies: [
                    {
                      id: "reply-1",
                      data: {
                        stockCode: "LOT",
                        pulseId: "pulse-1",
                        body: "Noted.",
                        status: "active",
                        createdAt: new Date("2026-04-11T08:05:00Z"),
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    const db = createDb();

    const stats = await backfillCommunityToPostgres({
      firestore,
      db,
      apply: true,
      logger: noopLogger(),
    });

    expect(stats.threadsWritten).toBe(1);
    expect(stats.commentsWritten).toBe(1);
    expect(stats.pulseWritten).toBe(1);
    expect(stats.pulseRepliesWritten).toBe(1);
    expect(db.queries).toHaveLength(4);
    expect(db.queries[0]?.text).toContain("INSERT INTO community_threads");
    expect(db.queries[0]?.text).toContain("ON CONFLICT (id) DO UPDATE");
    expect(db.queries[0]?.values?.[0]).toBe("thread-1");
    expect(db.queries[1]?.text).toContain("INSERT INTO community_comments");
    expect(db.queries[1]?.values?.[0]).toBe("comment-1");
    expect(db.queries[2]?.text).toContain("INSERT INTO community_pulse");
    expect(db.queries[2]?.values?.[0]).toBe("pulse-1");
    expect(db.queries[3]?.text).toContain("INSERT INTO community_pulse_replies");
    expect(db.queries[3]?.values?.[0]).toBe("reply-1");
  });

  it("upserts top-level votes and reports idempotently", async () => {
    const firestore = createFirestore({
      stock_communities: [],
      community_votes: [
        {
          id: "vote-1",
          data: {
            stockCode: "BHP",
            targetType: "thread",
            targetId: "thread-1",
            value: 1,
            userId: "user-1",
          },
        },
      ],
      community_reports: [
        {
          id: "report-1",
          data: {
            stockCode: "BHP",
            targetType: "thread",
            targetId: "thread-1",
            reason: "spam",
            details: "Repeated post",
            userId: "user-2",
          },
        },
      ],
    });
    const db = createDb();

    const stats = await backfillCommunityToPostgres({
      firestore,
      db,
      apply: true,
      includeVotes: true,
      includeReports: true,
      logger: noopLogger(),
    });

    expect(stats.votesWritten).toBe(1);
    expect(stats.reportsWritten).toBe(1);
    expect(db.queries[0]?.text).toContain("INSERT INTO community_votes");
    expect(db.queries[0]?.text).toContain(
      "ON CONFLICT (user_id, target_type, target_id) DO UPDATE",
    );
    expect(db.queries[1]?.text).toContain("INSERT INTO community_reports");
    expect(db.queries[1]?.text).toContain("ON CONFLICT (id) DO UPDATE");
  });
});

function noopLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}
