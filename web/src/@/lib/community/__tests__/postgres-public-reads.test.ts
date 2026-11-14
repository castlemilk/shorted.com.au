import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createPostgresCommunityStore } from "../postgres-community";

// Execute the actual portable SELECT predicates, not prefiltered query mocks.
// This embedded SQL contract test does not replace PostgreSQL integration.
function createReadFixture() {
  const database = new DatabaseSync(":memory:");
  const columns = `
    id TEXT PRIMARY KEY, stock_code TEXT, body TEXT DEFAULT 'Evidence',
    status TEXT, score INTEGER DEFAULT 0, reply_count INTEGER DEFAULT 0,
    author_user_id TEXT, author_display_name TEXT, author_handle TEXT,
    author_avatar_url TEXT, author_trust_score INTEGER,
    created_at TEXT DEFAULT '2026-11-10T00:00:00Z',
    updated_at TEXT DEFAULT '2026-11-10T00:00:00Z'
  `;
  database.exec(`
    CREATE TABLE community_threads (${columns}, type TEXT DEFAULT 'question',
      title TEXT DEFAULT 'Research question', comment_count INTEGER DEFAULT 0,
      source_count INTEGER DEFAULT 0, high_signal INTEGER DEFAULT 0,
      sources TEXT DEFAULT '[]', last_activity_at TEXT DEFAULT '2026-11-10T00:00:00Z');
    CREATE TABLE community_pulse (${columns});
    CREATE TABLE community_comments (${columns}, thread_id TEXT);
    CREATE TABLE community_pulse_replies (${columns}, pulse_id TEXT);
  `);
  for (const status of ["active", "needs_review", "hidden", "deleted", null]) {
    const id = status ?? "missing-status";
    database
      .prepare(
        "INSERT INTO community_threads (id, stock_code, status) VALUES (?, ?, ?)",
      )
      .run(id, "BHP", status);
    database
      .prepare(
        "INSERT INTO community_pulse (id, stock_code, status) VALUES (?, ?, ?)",
      )
      .run(id, "BHP", status);
    database
      .prepare(
        "INSERT INTO community_comments (id, stock_code, thread_id, status) VALUES (?, ?, ?, ?)",
      )
      .run(`comment-${id}`, "BHP", id, "active");
    database
      .prepare(
        "INSERT INTO community_pulse_replies (id, stock_code, pulse_id, status) VALUES (?, ?, ?, ?)",
      )
      .run(`reply-${id}`, "BHP", id, "active");
    if (status !== "active") {
      database
        .prepare(
          "INSERT INTO community_comments (id, stock_code, thread_id, status) VALUES (?, ?, ?, ?)",
        )
        .run(`held-comment-${id}`, "BHP", "active", status);
      database
        .prepare(
          "INSERT INTO community_pulse_replies (id, stock_code, pulse_id, status) VALUES (?, ?, ?, ?)",
        )
        .run(`held-reply-${id}`, "BHP", "active", status);
    }
  }
  database.exec(`
    INSERT INTO community_threads (id, stock_code, status) VALUES ('foreign', 'CBA', 'active');
    INSERT INTO community_pulse (id, stock_code, status) VALUES ('foreign', 'CBA', 'active');
    INSERT INTO community_comments (id, stock_code, thread_id, status) VALUES ('foreign-comment', 'BHP', 'foreign', 'active');
    INSERT INTO community_pulse_replies (id, stock_code, pulse_id, status) VALUES ('foreign-reply', 'BHP', 'foreign', 'active');
    INSERT INTO community_comments (id, stock_code, thread_id, status) VALUES ('orphan-comment', 'BHP', 'missing', 'active');
    INSERT INTO community_pulse_replies (id, stock_code, pulse_id, status) VALUES ('orphan-reply', 'BHP', 'missing', 'active');
  `);
  const store = createPostgresCommunityStore(() => ({
    async query<T extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      const parameters = Object.fromEntries(
        values.map((value, index) => [
          String(index + 1),
          value as SQLInputValue,
        ]),
      );
      return { rows: database.prepare(text).all(parameters) as T[] };
    },
  }));
  return { database, store };
}

describe("Postgres public community read contract", () => {
  let fixture: ReturnType<typeof createReadFixture>;
  beforeEach(() => {
    fixture = createReadFixture();
  });
  afterEach(() => {
    fixture.database.close();
  });

  it("returns only active stock content and active children of active parents", async () => {
    const { store } = fixture;
    expect(
      (await store.listCommunityThreads("bhp")).map(({ id }) => id),
    ).toEqual(["active"]);
    expect(
      (await store.listCommunityPulseItems("bhp")).map(({ id }) => id),
    ).toEqual(["active"]);
    expect((await store.getCommunityThread("bhp", "active"))?.id).toBe(
      "active",
    );
    expect(
      (await store.listCommunityComments("bhp", "active")).map(({ id }) => id),
    ).toEqual(["comment-active"]);
    expect(
      (await store.listCommunityPulseReplies("bhp", "active")).map(
        ({ id }) => id,
      ),
    ).toEqual(["reply-active"]);
  });

  it.each([
    "needs_review",
    "hidden",
    "deleted",
    "missing-status",
    "missing",
    "foreign",
  ])(
    "does not expose the %s thread or children through a direct ID",
    async (id) => {
      const { store } = fixture;
      expect(await store.getCommunityThread("BHP", id)).toBeNull();
      expect(await store.listCommunityComments("BHP", id)).toEqual([]);
      expect(await store.listCommunityPulseReplies("BHP", id)).toEqual([]);
    },
  );

  it("removes a formerly public thread and its replies on the next read", async () => {
    const { store, database } = fixture;
    expect(await store.getCommunityThread("BHP", "active")).not.toBeNull();
    expect(await store.listCommunityComments("BHP", "active")).toHaveLength(1);
    database.exec(
      "UPDATE community_threads SET status = 'hidden' WHERE id = 'active'",
    );
    expect(await store.getCommunityThread("BHP", "active")).toBeNull();
    expect(await store.listCommunityThreads("BHP")).toEqual([]);
    expect(await store.listCommunityComments("BHP", "active")).toEqual([]);
    expect(
      (await store.getStockCommunitySummary("BHP")).topThread,
    ).toBeUndefined();
  });
});
