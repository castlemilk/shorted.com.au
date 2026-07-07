import { createHash } from "node:crypto";
import { getPostgresPool, isPostgresConfigured } from "~/@/lib/postgres";
import { withPostgresCost } from "~/@/lib/postgres-cost";
import {
  type CommunityStore,
  type CreateCommunityCommentInput,
  type CreateCommunityPulseItemInput,
  type CreateCommunityPulseReplyInput,
  type CreateCommunityReportInput,
  type CreateCommunityThreadInput,
  type CreateCommunityVoteInput,
} from "./community-store";
import { rankPulseItems, rankResearchThreads } from "./ranking";
import { buildCommunitySummary } from "./summary";
import {
  type CommunityAuthorSnapshot,
  type CommunityComment,
  type CommunityOverviewSummary,
  type CommunityPulseItem,
  type CommunitySourceLink,
  type CommunityThread,
} from "~/@/types/community";

export const POSTGRES_COMMUNITY_THREAD_LIST_LIMIT = 25;
export const POSTGRES_COMMUNITY_PULSE_LIST_LIMIT = 25;
export const POSTGRES_COMMUNITY_COMMENT_LIST_LIMIT = 50;

type QueryResult<T extends Record<string, unknown>> = {
  rows: T[];
};

export type CommunityPostgresClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
};

type CommunityThreadRow = Record<string, unknown> & {
  id: string;
  stock_code: string;
  type: CommunityThread["type"];
  title: string;
  body: string;
  score: number;
  comment_count: number;
  source_count: number;
  high_signal: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  last_activity_at: Date | string;
  status: CommunityThread["status"];
  sources?: unknown;
};

type CommunityPulseRow = Record<string, unknown> & {
  id: string;
  stock_code: string;
  body: string;
  score: number;
  reply_count: number;
  created_at: Date | string;
  updated_at: Date | string;
  status: CommunityPulseItem["status"];
};

type CommunityCommentRow = Record<string, unknown> & {
  id: string;
  stock_code: string;
  thread_id?: string;
  pulse_id?: string;
  body: string;
  score: number;
  reply_count: number;
  created_at: Date | string;
  updated_at: Date | string;
  status: CommunityComment["status"];
};

type CommunityVoteRow = Record<string, unknown> & {
  id: string;
  stock_code: string;
  target_type: CreateCommunityVoteInput["targetType"];
  target_id: string;
  value: 1 | -1;
  user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type CommunityReportRow = Record<string, unknown> & {
  id: string;
  stock_code: string;
  target_type: CreateCommunityReportInput["targetType"];
  target_id: string;
  reason: string;
  details?: string | null;
  user_id: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
};

const THREAD_COLUMNS = `
  id,
  stock_code,
  type,
  title,
  body,
  score,
  comment_count,
  source_count,
  high_signal,
  status,
  author_user_id,
  author_display_name,
  author_handle,
  author_avatar_url,
  author_trust_score,
  sources,
  created_at,
  updated_at,
  last_activity_at
`;

const PULSE_COLUMNS = `
  id,
  stock_code,
  body,
  score,
  reply_count,
  status,
  author_user_id,
  author_display_name,
  author_handle,
  author_avatar_url,
  author_trust_score,
  created_at,
  updated_at
`;

const COMMENT_COLUMNS = `
  id,
  stock_code,
  thread_id,
  body,
  score,
  reply_count,
  status,
  author_user_id,
  author_display_name,
  author_handle,
  author_avatar_url,
  author_trust_score,
  created_at,
  updated_at
`;

const PULSE_REPLY_COLUMNS = `
  id,
  stock_code,
  pulse_id,
  body,
  score,
  reply_count,
  status,
  author_user_id,
  author_display_name,
  author_handle,
  author_avatar_url,
  author_trust_score,
  created_at,
  updated_at
`;

export function isPostgresCommunityConfigured() {
  return isPostgresConfigured();
}

export function createPostgresCommunityStore(
  getDb: () => CommunityPostgresClient,
): CommunityStore {
  const store: CommunityStore = {
    async getStockCommunitySummary(
      stockCode: string,
    ): Promise<CommunityOverviewSummary> {
      const normalizedStockCode = normalizeStockCode(stockCode);
      const [threads, pulse] = await Promise.all([
        store.listCommunityThreads(normalizedStockCode),
        store.listCommunityPulseItems(normalizedStockCode),
      ]);

      return buildCommunitySummary({
        stockCode: normalizedStockCode,
        threads,
        pulse,
      });
    },

    async listCommunityThreads(stockCode: string): Promise<CommunityThread[]> {
      const rows = await selectRows<CommunityThreadRow>(
        getDb(),
        "community_threads",
        `
          SELECT ${THREAD_COLUMNS}
          FROM community_threads
          WHERE stock_code = $1
            AND status = 'active'
          ORDER BY last_activity_at DESC, id DESC
          LIMIT $2
        `,
        [
          normalizeStockCode(stockCode),
          POSTGRES_COMMUNITY_THREAD_LIST_LIMIT,
        ],
      );

      return rankResearchThreads(rows.map(mapThread));
    },

    async getCommunityThread(
      stockCode: string,
      threadId: string,
    ): Promise<CommunityThread | null> {
      const rows = await selectRows<CommunityThreadRow>(
        getDb(),
        "community_threads",
        `
          SELECT ${THREAD_COLUMNS}
          FROM community_threads
          WHERE stock_code = $1
            AND id = $2
          LIMIT 1
        `,
        [normalizeStockCode(stockCode), threadId],
      );

      return rows[0] ? mapThread(rows[0]) : null;
    },

    async listCommunityPulseItems(
      stockCode: string,
    ): Promise<CommunityPulseItem[]> {
      const rows = await selectRows<CommunityPulseRow>(
        getDb(),
        "community_pulse",
        `
          SELECT ${PULSE_COLUMNS}
          FROM community_pulse
          WHERE stock_code = $1
            AND status = 'active'
          ORDER BY created_at DESC, id DESC
          LIMIT $2
        `,
        [
          normalizeStockCode(stockCode),
          POSTGRES_COMMUNITY_PULSE_LIST_LIMIT,
        ],
      );

      return rankPulseItems(rows.map(mapPulseItem));
    },

    async listCommunityComments(
      stockCode: string,
      threadId: string,
    ): Promise<CommunityComment[]> {
      const rows = await selectRows<CommunityCommentRow>(
        getDb(),
        "community_comments",
        `
          SELECT ${COMMENT_COLUMNS}
          FROM community_comments
          WHERE stock_code = $1
            AND thread_id = $2
            AND status = 'active'
          ORDER BY created_at ASC, id ASC
          LIMIT $3
        `,
        [
          normalizeStockCode(stockCode),
          threadId,
          POSTGRES_COMMUNITY_COMMENT_LIST_LIMIT,
        ],
      );

      return rows.map(mapComment);
    },

    async listCommunityPulseReplies(
      stockCode: string,
      pulseId: string,
    ): Promise<CommunityComment[]> {
      const rows = await selectRows<CommunityCommentRow>(
        getDb(),
        "community_pulse_replies",
        `
          SELECT ${PULSE_REPLY_COLUMNS}
          FROM community_pulse_replies
          WHERE stock_code = $1
            AND pulse_id = $2
            AND status = 'active'
          ORDER BY created_at ASC, id ASC
          LIMIT $3
        `,
        [
          normalizeStockCode(stockCode),
          pulseId,
          POSTGRES_COMMUNITY_COMMENT_LIST_LIMIT,
        ],
      );

      return rows.map(mapComment);
    },

    async createCommunityThread(
      input: CreateCommunityThreadInput,
    ): Promise<CommunityThread> {
      const sources = input.sources ?? [];
      const rows = await writeRows<CommunityThreadRow>(
        getDb(),
        "community_threads",
        "insert",
        `
          INSERT INTO community_threads (
            stock_code,
            type,
            title,
            body,
            source_count,
            high_signal,
            status,
            author_user_id,
            author_display_name,
            author_handle,
            author_avatar_url,
            author_trust_score,
            sources
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
          RETURNING ${THREAD_COLUMNS}
        `,
        [
          normalizeStockCode(input.stockCode),
          input.type,
          input.title,
          input.body,
          sources.length,
          sources.length >= 2,
          input.status,
          input.author.userId,
          input.author.displayName,
          input.author.handle ?? null,
          input.author.avatarUrl ?? null,
          input.author.trustScore ?? null,
          JSON.stringify(sources),
        ],
      );

      return mapThread(requireRow(rows, "community thread"));
    },

    async createCommunityComment(
      input: CreateCommunityCommentInput,
    ): Promise<CommunityComment> {
      const rows = await writeRows<CommunityCommentRow>(
        getDb(),
        "community_comments",
        "insert",
        `
          INSERT INTO community_comments (
            stock_code,
            thread_id,
            body,
            status,
            author_user_id,
            author_display_name,
            author_handle,
            author_avatar_url,
            author_trust_score
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING ${COMMENT_COLUMNS}
        `,
        [
          normalizeStockCode(input.stockCode),
          input.threadId,
          input.body,
          input.status,
          input.author.userId,
          input.author.displayName,
          input.author.handle ?? null,
          input.author.avatarUrl ?? null,
          input.author.trustScore ?? null,
        ],
      );

      return mapComment(requireRow(rows, "community comment"));
    },

    async createCommunityPulseItem(
      input: CreateCommunityPulseItemInput,
    ): Promise<CommunityPulseItem> {
      const rows = await writeRows<CommunityPulseRow>(
        getDb(),
        "community_pulse",
        "insert",
        `
          INSERT INTO community_pulse (
            stock_code,
            body,
            status,
            author_user_id,
            author_display_name,
            author_handle,
            author_avatar_url,
            author_trust_score
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING ${PULSE_COLUMNS}
        `,
        [
          normalizeStockCode(input.stockCode),
          input.body,
          input.status,
          input.author.userId,
          input.author.displayName,
          input.author.handle ?? null,
          input.author.avatarUrl ?? null,
          input.author.trustScore ?? null,
        ],
      );

      return mapPulseItem(requireRow(rows, "community pulse item"));
    },

    async createCommunityPulseReply(
      input: CreateCommunityPulseReplyInput,
    ): Promise<CommunityComment> {
      const rows = await writeRows<CommunityCommentRow>(
        getDb(),
        "community_pulse_replies",
        "insert",
        `
          INSERT INTO community_pulse_replies (
            stock_code,
            pulse_id,
            body,
            status,
            author_user_id,
            author_display_name,
            author_handle,
            author_avatar_url,
            author_trust_score
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING ${PULSE_REPLY_COLUMNS}
        `,
        [
          normalizeStockCode(input.stockCode),
          input.pulseId,
          input.body,
          input.status,
          input.author.userId,
          input.author.displayName,
          input.author.handle ?? null,
          input.author.avatarUrl ?? null,
          input.author.trustScore ?? null,
        ],
      );

      return mapComment(requireRow(rows, "community pulse reply"));
    },

    async createCommunityVote(input: CreateCommunityVoteInput) {
      const rows = await writeRows<CommunityVoteRow>(
        getDb(),
        "community_votes",
        "upsert",
        `
          INSERT INTO community_votes (
            id,
            stock_code,
            target_type,
            target_id,
            value,
            user_id
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (user_id, target_type, target_id) DO UPDATE
          SET value = EXCLUDED.value,
              stock_code = EXCLUDED.stock_code,
              updated_at = now()
          RETURNING
            id,
            stock_code,
            target_type,
            target_id,
            value,
            user_id,
            created_at,
            updated_at
        `,
        [
          stableCommunityVoteId(
            input.userId,
            input.targetType,
            input.targetId,
          ),
          normalizeStockCode(input.stockCode),
          input.targetType,
          input.targetId,
          input.value,
          input.userId,
        ],
      );

      return mapVote(requireRow(rows, "community vote"));
    },

    async createCommunityReport(input: CreateCommunityReportInput) {
      const rows = await writeRows<CommunityReportRow>(
        getDb(),
        "community_reports",
        "insert",
        `
          INSERT INTO community_reports (
            stock_code,
            target_type,
            target_id,
            reason,
            details,
            user_id
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING
            id,
            stock_code,
            target_type,
            target_id,
            reason,
            details,
            user_id,
            status,
            created_at,
            updated_at
        `,
        [
          normalizeStockCode(input.stockCode),
          input.targetType,
          input.targetId,
          input.reason,
          input.details ?? null,
          input.userId,
        ],
      );

      return mapReport(requireRow(rows, "community report"));
    },
  };

  return store;
}

export const postgresCommunityStore = createPostgresCommunityStore(
  getPostgresPool,
);

async function selectRows<T extends Record<string, unknown>>(
  db: CommunityPostgresClient,
  relation: string,
  text: string,
  values: readonly unknown[],
): Promise<T[]> {
  const result = await withPostgresCost(
    {
      feature: "community",
      relation,
      operation: "select",
      rowsRead: (queryResult: QueryResult<T>) => queryResult.rows.length,
    },
    () => db.query<T>(text, values),
  );

  return result.rows;
}

async function writeRows<T extends Record<string, unknown>>(
  db: CommunityPostgresClient,
  relation: string,
  operation: "insert" | "upsert",
  text: string,
  values: readonly unknown[],
): Promise<T[]> {
  const result = await withPostgresCost(
    {
      feature: "community",
      relation,
      operation,
      rowsWritten: (queryResult: QueryResult<T>) =>
        queryResult.rows.length > 0 ? 1 : 0,
    },
    () => db.query<T>(text, values),
  );

  return result.rows;
}

function mapThread(row: CommunityThreadRow): CommunityThread {
  return {
    id: row.id,
    stockCode: row.stock_code,
    type: row.type,
    title: row.title,
    body: row.body,
    score: Number(row.score ?? 0),
    commentCount: Number(row.comment_count ?? 0),
    sourceCount: Number(row.source_count ?? 0),
    highSignal: Boolean(row.high_signal),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    lastActivityAt: toDate(row.last_activity_at),
    status: row.status,
    author: mapAuthor(row),
    sources: mapSources(row.sources),
  };
}

function mapPulseItem(row: CommunityPulseRow): CommunityPulseItem {
  return {
    id: row.id,
    stockCode: row.stock_code,
    body: row.body,
    score: Number(row.score ?? 0),
    replyCount: Number(row.reply_count ?? 0),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    status: row.status,
    author: mapAuthor(row),
  };
}

function mapComment(row: CommunityCommentRow): CommunityComment {
  return {
    id: row.id,
    stockCode: row.stock_code,
    threadId: String(row.thread_id ?? row.pulse_id ?? ""),
    body: row.body,
    score: Number(row.score ?? 0),
    replyCount: Number(row.reply_count ?? 0),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    status: row.status,
    author: mapAuthor(row),
  };
}

function mapVote(row: CommunityVoteRow) {
  return {
    id: row.id,
    stockCode: row.stock_code,
    targetType: row.target_type,
    targetId: row.target_id,
    value: row.value,
    userId: row.user_id,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapReport(row: CommunityReportRow) {
  return {
    id: row.id,
    stockCode: row.stock_code,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    details: row.details ?? undefined,
    userId: row.user_id,
    status: row.status,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapAuthor(row: Record<string, unknown>): CommunityAuthorSnapshot | undefined {
  if (!row.author_user_id && !row.author_display_name) {
    return undefined;
  }

  return {
    userId: String(row.author_user_id ?? ""),
    displayName: String(row.author_display_name ?? "Anonymous"),
    handle:
      row.author_handle !== null && row.author_handle !== undefined
        ? String(row.author_handle)
        : undefined,
    avatarUrl:
      row.author_avatar_url !== null && row.author_avatar_url !== undefined
        ? String(row.author_avatar_url)
        : undefined,
    trustScore:
      row.author_trust_score !== null && row.author_trust_score !== undefined
        ? Number(row.author_trust_score)
        : undefined,
  };
}

function mapSources(value: unknown): CommunitySourceLink[] | undefined {
  const parsed = parseJsonArray(value);
  const sources = parsed
    .filter(
      (source): source is Record<string, unknown> =>
        typeof source === "object" && source !== null,
    )
    .map((source) => ({
      label: String(source.label ?? ""),
      url: String(source.url ?? ""),
    }))
    .filter((source) => source.label && source.url);

  return sources.length > 0 ? sources : undefined;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function toDate(value: Date | string | number | null | undefined): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date(0);
}

function stableCommunityVoteId(
  userId: string,
  targetType: CreateCommunityVoteInput["targetType"],
  targetId: string,
): string {
  return createHash("sha1")
    .update(`${userId}\u0000${targetType}\u0000${targetId}`)
    .digest("hex");
}

function requireRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`Postgres did not return ${label}`);
  }
  return row;
}

function normalizeStockCode(stockCode: string) {
  return stockCode.toUpperCase();
}
