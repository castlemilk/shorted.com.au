#!/usr/bin/env tsx

import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { adminDb } from "../src/@/lib/firebase-admin";

const { Pool } = pg;

export type FirestoreDocLike = {
  id: string;
  data: () => Record<string, unknown> | undefined;
  ref?: {
    collection: (name: string) => FirestoreCollectionLike;
  };
};

export type FirestoreQuerySnapshotLike = {
  docs: FirestoreDocLike[];
};

export type FirestoreCollectionLike = {
  get: () => Promise<FirestoreQuerySnapshotLike>;
};

export type FirestoreDbLike = {
  collection: (name: string) => FirestoreCollectionLike;
};

export type CommunityBackfillDb = {
  query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

export type CommunityBackfillLogger = Pick<
  typeof console,
  "info" | "warn" | "error"
>;

export type CommunityBackfillStats = {
  stocksRead: number;
  stocksProcessed: number;
  threadsRead: number;
  threadsWritten: number;
  commentsRead: number;
  commentsWritten: number;
  pulseRead: number;
  pulseWritten: number;
  pulseRepliesRead: number;
  pulseRepliesWritten: number;
  votesRead: number;
  votesWritten: number;
  reportsRead: number;
  reportsWritten: number;
  skipped: number;
};

type CommunityBackfillOptions = {
  firestore: FirestoreDbLike;
  db: CommunityBackfillDb;
  apply: boolean;
  stocks?: string[];
  maxStocks?: number;
  includeVotes?: boolean;
  includeReports?: boolean;
  logger?: CommunityBackfillLogger;
};

type AuthorSnapshot = {
  userId: string | null;
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  trustScore: number | null;
};

const VALID_THREAD_TYPES = new Set([
  "bull",
  "bear",
  "catalyst",
  "question",
  "news_reaction",
]);

const VALID_COMMUNITY_STATUSES = new Set([
  "active",
  "hidden",
  "deleted",
  "needs_review",
]);

const VALID_TARGET_TYPES = new Set([
  "thread",
  "comment",
  "pulse",
  "pulse_reply",
]);

const now = () => new Date();

export async function backfillCommunityToPostgres({
  firestore,
  db,
  apply,
  stocks,
  maxStocks,
  includeVotes = true,
  includeReports = true,
  logger = console,
}: CommunityBackfillOptions): Promise<CommunityBackfillStats> {
  const stats = emptyStats();
  const stockFilter = new Set((stocks ?? []).map(normalizeStockCode));
  const stockSnapshot = await firestore.collection("stock_communities").get();
  const stockDocs = stockSnapshot.docs.filter((doc) =>
    stockFilter.size === 0 ? true : stockFilter.has(normalizeStockCode(doc.id)),
  );
  const selectedStockDocs =
    maxStocks && maxStocks > 0 ? stockDocs.slice(0, maxStocks) : stockDocs;

  stats.stocksRead = stockSnapshot.docs.length;

  logger.info(
    `[community-backfill] mode=${apply ? "apply" : "dry-run"} stocks=${selectedStockDocs.length}`,
  );

  for (const stockDoc of selectedStockDocs) {
    const stockCode = normalizeStockCode(stockDoc.id);
    stats.stocksProcessed += 1;

    await backfillThreads({
      db,
      stockDoc,
      stockCode,
      apply,
      stats,
      logger,
    });
    await backfillPulse({
      db,
      stockDoc,
      stockCode,
      apply,
      stats,
      logger,
    });
  }

  if (includeVotes) {
    await backfillVotes({ firestore, db, apply, stats, stockFilter, logger });
  }

  if (includeReports) {
    await backfillReports({ firestore, db, apply, stats, stockFilter, logger });
  }

  logger.info(`[community-backfill] complete ${JSON.stringify(stats)}`);
  return stats;
}

async function backfillThreads({
  db,
  stockDoc,
  stockCode,
  apply,
  stats,
  logger,
}: {
  db: CommunityBackfillDb;
  stockDoc: FirestoreDocLike;
  stockCode: string;
  apply: boolean;
  stats: CommunityBackfillStats;
  logger: CommunityBackfillLogger;
}) {
  const threadsSnapshot = await requireSubcollection(stockDoc, "threads").get();
  stats.threadsRead += threadsSnapshot.docs.length;

  for (const threadDoc of threadsSnapshot.docs) {
    const thread = mapThreadDoc(stockCode, threadDoc);
    if (!thread) {
      stats.skipped += 1;
      logger.warn(`[community-backfill] skipped invalid thread ${stockCode}/${threadDoc.id}`);
      continue;
    }

    if (apply) {
      await upsertThread(db, thread);
      stats.threadsWritten += 1;
    }

    const commentsSnapshot = await requireSubcollection(threadDoc, "comments").get();
    stats.commentsRead += commentsSnapshot.docs.length;

    for (const commentDoc of commentsSnapshot.docs) {
      const comment = mapCommentDoc(stockCode, thread.id, commentDoc);
      if (!comment) {
        stats.skipped += 1;
        logger.warn(
          `[community-backfill] skipped invalid comment ${stockCode}/${thread.id}/${commentDoc.id}`,
        );
        continue;
      }

      if (apply) {
        await upsertComment(db, comment);
        stats.commentsWritten += 1;
      }
    }
  }
}

async function backfillPulse({
  db,
  stockDoc,
  stockCode,
  apply,
  stats,
  logger,
}: {
  db: CommunityBackfillDb;
  stockDoc: FirestoreDocLike;
  stockCode: string;
  apply: boolean;
  stats: CommunityBackfillStats;
  logger: CommunityBackfillLogger;
}) {
  const pulseSnapshot = await requireSubcollection(stockDoc, "pulse").get();
  stats.pulseRead += pulseSnapshot.docs.length;

  for (const pulseDoc of pulseSnapshot.docs) {
    const pulse = mapPulseDoc(stockCode, pulseDoc);
    if (!pulse) {
      stats.skipped += 1;
      logger.warn(`[community-backfill] skipped invalid pulse ${stockCode}/${pulseDoc.id}`);
      continue;
    }

    if (apply) {
      await upsertPulse(db, pulse);
      stats.pulseWritten += 1;
    }

    const repliesSnapshot = await requireSubcollection(pulseDoc, "replies").get();
    stats.pulseRepliesRead += repliesSnapshot.docs.length;

    for (const replyDoc of repliesSnapshot.docs) {
      const reply = mapPulseReplyDoc(stockCode, pulse.id, replyDoc);
      if (!reply) {
        stats.skipped += 1;
        logger.warn(
          `[community-backfill] skipped invalid pulse reply ${stockCode}/${pulse.id}/${replyDoc.id}`,
        );
        continue;
      }

      if (apply) {
        await upsertPulseReply(db, reply);
        stats.pulseRepliesWritten += 1;
      }
    }
  }
}

async function backfillVotes({
  firestore,
  db,
  apply,
  stats,
  stockFilter,
  logger,
}: {
  firestore: FirestoreDbLike;
  db: CommunityBackfillDb;
  apply: boolean;
  stats: CommunityBackfillStats;
  stockFilter: Set<string>;
  logger: CommunityBackfillLogger;
}) {
  const snapshot = await firestore.collection("community_votes").get();
  const docs = filterDocsByStock(snapshot.docs, stockFilter);
  stats.votesRead += docs.length;

  for (const voteDoc of docs) {
    const vote = mapVoteDoc(voteDoc);
    if (!vote) {
      stats.skipped += 1;
      logger.warn(`[community-backfill] skipped invalid vote ${voteDoc.id}`);
      continue;
    }

    if (apply) {
      await upsertVote(db, vote);
      stats.votesWritten += 1;
    }
  }
}

async function backfillReports({
  firestore,
  db,
  apply,
  stats,
  stockFilter,
  logger,
}: {
  firestore: FirestoreDbLike;
  db: CommunityBackfillDb;
  apply: boolean;
  stats: CommunityBackfillStats;
  stockFilter: Set<string>;
  logger: CommunityBackfillLogger;
}) {
  const snapshot = await firestore.collection("community_reports").get();
  const docs = filterDocsByStock(snapshot.docs, stockFilter);
  stats.reportsRead += docs.length;

  for (const reportDoc of docs) {
    const report = mapReportDoc(reportDoc);
    if (!report) {
      stats.skipped += 1;
      logger.warn(`[community-backfill] skipped invalid report ${reportDoc.id}`);
      continue;
    }

    if (apply) {
      await upsertReport(db, report);
      stats.reportsWritten += 1;
    }
  }
}

function mapThreadDoc(stockCode: string, doc: FirestoreDocLike) {
  const data = doc.data() ?? {};
  const createdAt = toDate(data.createdAt) ?? now();
  const updatedAt = toDate(data.updatedAt) ?? createdAt;
  const sources = normalizeSources(data.sources);
  const sourceCount = toNumber(data.sourceCount) ?? sources.length;
  const type = normalizeThreadType(data.type);

  if (!type) {
    return null;
  }

  return {
    id: doc.id,
    stockCode: normalizeStockCode(toString(data.stockCode) ?? stockCode),
    type,
    title: toString(data.title) ?? "",
    body: toString(data.body) ?? "",
    score: toNumber(data.score) ?? 0,
    commentCount: toNumber(data.commentCount) ?? 0,
    sourceCount,
    highSignal: toBoolean(data.highSignal) ?? sourceCount >= 2,
    status: normalizeStatus(data.status),
    author: normalizeAuthor(data.author),
    sources,
    createdAt,
    updatedAt,
    lastActivityAt: toDate(data.lastActivityAt) ?? updatedAt,
  };
}

function mapCommentDoc(stockCode: string, threadId: string, doc: FirestoreDocLike) {
  const data = doc.data() ?? {};
  const createdAt = toDate(data.createdAt) ?? now();

  return {
    id: doc.id,
    stockCode: normalizeStockCode(toString(data.stockCode) ?? stockCode),
    threadId: toString(data.threadId) ?? threadId,
    body: toString(data.body) ?? "",
    score: toNumber(data.score) ?? 0,
    replyCount: toNumber(data.replyCount) ?? 0,
    status: normalizeStatus(data.status),
    author: normalizeAuthor(data.author),
    createdAt,
    updatedAt: toDate(data.updatedAt) ?? createdAt,
  };
}

function mapPulseDoc(stockCode: string, doc: FirestoreDocLike) {
  const data = doc.data() ?? {};
  const createdAt = toDate(data.createdAt) ?? now();

  return {
    id: doc.id,
    stockCode: normalizeStockCode(toString(data.stockCode) ?? stockCode),
    body: toString(data.body) ?? "",
    score: toNumber(data.score) ?? 0,
    replyCount: toNumber(data.replyCount) ?? 0,
    status: normalizeStatus(data.status),
    author: normalizeAuthor(data.author),
    createdAt,
    updatedAt: toDate(data.updatedAt) ?? createdAt,
  };
}

function mapPulseReplyDoc(stockCode: string, pulseId: string, doc: FirestoreDocLike) {
  const data = doc.data() ?? {};
  const createdAt = toDate(data.createdAt) ?? now();

  return {
    id: doc.id,
    stockCode: normalizeStockCode(toString(data.stockCode) ?? stockCode),
    pulseId: toString(data.threadId) ?? toString(data.pulseId) ?? pulseId,
    body: toString(data.body) ?? "",
    score: toNumber(data.score) ?? 0,
    replyCount: toNumber(data.replyCount) ?? 0,
    status: normalizeStatus(data.status),
    author: normalizeAuthor(data.author),
    createdAt,
    updatedAt: toDate(data.updatedAt) ?? createdAt,
  };
}

function mapVoteDoc(doc: FirestoreDocLike) {
  const data = doc.data() ?? {};
  const targetType = normalizeTargetType(data.targetType);
  const stockCode = toString(data.stockCode);
  const targetId = toString(data.targetId);
  const userId = toString(data.userId);
  const value = normalizeVoteValue(data.value);
  const createdAt = toDate(data.createdAt) ?? now();

  if (!stockCode || !targetType || !targetId || !userId || !value) {
    return null;
  }

  return {
    id: doc.id,
    stockCode: normalizeStockCode(stockCode),
    targetType,
    targetId,
    value,
    userId,
    createdAt,
    updatedAt: toDate(data.updatedAt) ?? createdAt,
  };
}

function mapReportDoc(doc: FirestoreDocLike) {
  const data = doc.data() ?? {};
  const targetType = normalizeTargetType(data.targetType);
  const stockCode = toString(data.stockCode);
  const targetId = toString(data.targetId);
  const reason = toString(data.reason);
  const userId = toString(data.userId);
  const createdAt = toDate(data.createdAt) ?? now();

  if (!stockCode || !targetType || !targetId || !reason || !userId) {
    return null;
  }

  return {
    id: doc.id,
    stockCode: normalizeStockCode(stockCode),
    targetType,
    targetId,
    reason,
    details: toString(data.details),
    userId,
    status: toString(data.status) ?? "open",
    createdAt,
    updatedAt: toDate(data.updatedAt) ?? createdAt,
  };
}

async function upsertThread(db: CommunityBackfillDb, thread: NonNullable<ReturnType<typeof mapThreadDoc>>) {
  const author = thread.author;
  await db.query(
    `
      INSERT INTO community_threads (
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
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19)
      ON CONFLICT (id) DO UPDATE
      SET stock_code = EXCLUDED.stock_code,
          type = EXCLUDED.type,
          title = EXCLUDED.title,
          body = EXCLUDED.body,
          score = EXCLUDED.score,
          comment_count = EXCLUDED.comment_count,
          source_count = EXCLUDED.source_count,
          high_signal = EXCLUDED.high_signal,
          status = EXCLUDED.status,
          author_user_id = EXCLUDED.author_user_id,
          author_display_name = EXCLUDED.author_display_name,
          author_handle = EXCLUDED.author_handle,
          author_avatar_url = EXCLUDED.author_avatar_url,
          author_trust_score = EXCLUDED.author_trust_score,
          sources = EXCLUDED.sources,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          last_activity_at = EXCLUDED.last_activity_at
    `,
    [
      thread.id,
      thread.stockCode,
      thread.type,
      thread.title,
      thread.body,
      thread.score,
      thread.commentCount,
      thread.sourceCount,
      thread.highSignal,
      thread.status,
      author.userId,
      author.displayName,
      author.handle,
      author.avatarUrl,
      author.trustScore,
      JSON.stringify(thread.sources),
      thread.createdAt,
      thread.updatedAt,
      thread.lastActivityAt,
    ],
  );
}

async function upsertComment(db: CommunityBackfillDb, comment: ReturnType<typeof mapCommentDoc>) {
  const author = comment.author;
  await db.query(
    `
      INSERT INTO community_comments (
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
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO UPDATE
      SET stock_code = EXCLUDED.stock_code,
          thread_id = EXCLUDED.thread_id,
          body = EXCLUDED.body,
          score = EXCLUDED.score,
          reply_count = EXCLUDED.reply_count,
          status = EXCLUDED.status,
          author_user_id = EXCLUDED.author_user_id,
          author_display_name = EXCLUDED.author_display_name,
          author_handle = EXCLUDED.author_handle,
          author_avatar_url = EXCLUDED.author_avatar_url,
          author_trust_score = EXCLUDED.author_trust_score,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
    `,
    [
      comment.id,
      comment.stockCode,
      comment.threadId,
      comment.body,
      comment.score,
      comment.replyCount,
      comment.status,
      author.userId,
      author.displayName,
      author.handle,
      author.avatarUrl,
      author.trustScore,
      comment.createdAt,
      comment.updatedAt,
    ],
  );
}

async function upsertPulse(db: CommunityBackfillDb, pulse: ReturnType<typeof mapPulseDoc>) {
  const author = pulse.author;
  await db.query(
    `
      INSERT INTO community_pulse (
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
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (id) DO UPDATE
      SET stock_code = EXCLUDED.stock_code,
          body = EXCLUDED.body,
          score = EXCLUDED.score,
          reply_count = EXCLUDED.reply_count,
          status = EXCLUDED.status,
          author_user_id = EXCLUDED.author_user_id,
          author_display_name = EXCLUDED.author_display_name,
          author_handle = EXCLUDED.author_handle,
          author_avatar_url = EXCLUDED.author_avatar_url,
          author_trust_score = EXCLUDED.author_trust_score,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
    `,
    [
      pulse.id,
      pulse.stockCode,
      pulse.body,
      pulse.score,
      pulse.replyCount,
      pulse.status,
      author.userId,
      author.displayName,
      author.handle,
      author.avatarUrl,
      author.trustScore,
      pulse.createdAt,
      pulse.updatedAt,
    ],
  );
}

async function upsertPulseReply(
  db: CommunityBackfillDb,
  reply: ReturnType<typeof mapPulseReplyDoc>,
) {
  const author = reply.author;
  await db.query(
    `
      INSERT INTO community_pulse_replies (
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
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO UPDATE
      SET stock_code = EXCLUDED.stock_code,
          pulse_id = EXCLUDED.pulse_id,
          body = EXCLUDED.body,
          score = EXCLUDED.score,
          reply_count = EXCLUDED.reply_count,
          status = EXCLUDED.status,
          author_user_id = EXCLUDED.author_user_id,
          author_display_name = EXCLUDED.author_display_name,
          author_handle = EXCLUDED.author_handle,
          author_avatar_url = EXCLUDED.author_avatar_url,
          author_trust_score = EXCLUDED.author_trust_score,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
    `,
    [
      reply.id,
      reply.stockCode,
      reply.pulseId,
      reply.body,
      reply.score,
      reply.replyCount,
      reply.status,
      author.userId,
      author.displayName,
      author.handle,
      author.avatarUrl,
      author.trustScore,
      reply.createdAt,
      reply.updatedAt,
    ],
  );
}

async function upsertVote(db: CommunityBackfillDb, vote: NonNullable<ReturnType<typeof mapVoteDoc>>) {
  await db.query(
    `
      INSERT INTO community_votes (
        id,
        stock_code,
        target_type,
        target_id,
        value,
        user_id,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id, target_type, target_id) DO UPDATE
      SET stock_code = EXCLUDED.stock_code,
          value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
    `,
    [
      vote.id,
      vote.stockCode,
      vote.targetType,
      vote.targetId,
      vote.value,
      vote.userId,
      vote.createdAt,
      vote.updatedAt,
    ],
  );
}

async function upsertReport(
  db: CommunityBackfillDb,
  report: NonNullable<ReturnType<typeof mapReportDoc>>,
) {
  await db.query(
    `
      INSERT INTO community_reports (
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
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE
      SET stock_code = EXCLUDED.stock_code,
          target_type = EXCLUDED.target_type,
          target_id = EXCLUDED.target_id,
          reason = EXCLUDED.reason,
          details = EXCLUDED.details,
          user_id = EXCLUDED.user_id,
          status = EXCLUDED.status,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
    `,
    [
      report.id,
      report.stockCode,
      report.targetType,
      report.targetId,
      report.reason,
      report.details,
      report.userId,
      report.status,
      report.createdAt,
      report.updatedAt,
    ],
  );
}

function filterDocsByStock(docs: FirestoreDocLike[], stockFilter: Set<string>) {
  if (stockFilter.size === 0) {
    return docs;
  }

  return docs.filter((doc) => {
    const stockCode = toString(doc.data()?.stockCode);
    return stockCode ? stockFilter.has(normalizeStockCode(stockCode)) : false;
  });
}

function requireSubcollection(doc: FirestoreDocLike, name: string) {
  if (!doc.ref) {
    throw new Error(`Firestore document ${doc.id} does not expose ref.collection`);
  }

  return doc.ref.collection(name);
}

function normalizeAuthor(value: unknown): AuthorSnapshot {
  const data =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  return {
    userId: toString(data.userId),
    displayName: toString(data.displayName),
    handle: toString(data.handle),
    avatarUrl: toString(data.avatarUrl),
    trustScore: toNumber(data.trustScore),
  };
}

function normalizeSources(value: unknown): Array<{ label: string; url: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    )
    .map((item) => ({
      label: toString(item.label) ?? "",
      url: toString(item.url) ?? "",
    }))
    .filter((item) => item.label && item.url);
}

function normalizeThreadType(value: unknown) {
  const type = toString(value) ?? "question";
  return VALID_THREAD_TYPES.has(type) ? type : null;
}

function normalizeStatus(value: unknown) {
  const status = toString(value) ?? "active";
  return VALID_COMMUNITY_STATUSES.has(status) ? status : "active";
}

function normalizeTargetType(value: unknown) {
  const targetType = toString(value);
  return targetType && VALID_TARGET_TYPES.has(targetType) ? targetType : null;
}

function normalizeVoteValue(value: unknown): 1 | -1 | null {
  const numberValue = toNumber(value);
  if (numberValue === 1) return 1;
  if (numberValue === -1) return -1;
  return null;
}

function normalizeStockCode(value: string) {
  return value.trim().toUpperCase();
}

function toString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }

  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    const parsed = value.toDate();
    return parsed instanceof Date ? parsed : null;
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function emptyStats(): CommunityBackfillStats {
  return {
    stocksRead: 0,
    stocksProcessed: 0,
    threadsRead: 0,
    threadsWritten: 0,
    commentsRead: 0,
    commentsWritten: 0,
    pulseRead: 0,
    pulseWritten: 0,
    pulseRepliesRead: 0,
    pulseRepliesWritten: 0,
    votesRead: 0,
    votesWritten: 0,
    reportsRead: 0,
    reportsWritten: 0,
    skipped: 0,
  };
}

function parseArgs(argv: string[]) {
  const stocks: string[] = [];
  let apply = false;
  let includeVotes = true;
  let includeReports = true;
  let maxStocks: number | undefined;
  let envFile: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--apply") {
      apply = true;
      continue;
    }

    if (arg === "--dry-run") {
      apply = false;
      continue;
    }

    if (arg === "--skip-votes") {
      includeVotes = false;
      continue;
    }

    if (arg === "--skip-reports") {
      includeReports = false;
      continue;
    }

    if (arg === "--stock") {
      const value = argv[index + 1];
      if (!value) throw new Error("--stock requires a value");
      stocks.push(normalizeStockCode(value));
      index += 1;
      continue;
    }

    if (arg.startsWith("--stock=")) {
      stocks.push(normalizeStockCode(arg.slice("--stock=".length)));
      continue;
    }

    if (arg === "--max-stocks") {
      const value = argv[index + 1];
      if (!value) throw new Error("--max-stocks requires a value");
      maxStocks = Number.parseInt(value, 10);
      index += 1;
      continue;
    }

    if (arg.startsWith("--max-stocks=")) {
      maxStocks = Number.parseInt(arg.slice("--max-stocks=".length), 10);
      continue;
    }

    if (arg === "--env-file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--env-file requires a value");
      envFile = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--env-file=")) {
      envFile = arg.slice("--env-file=".length);
      continue;
    }

    if (arg === "--help") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    apply,
    stocks,
    includeVotes,
    includeReports,
    envFile,
    maxStocks: Number.isFinite(maxStocks) && (maxStocks ?? 0) > 0
      ? maxStocks
      : undefined,
  };
}

function printUsage() {
  console.info(`Usage:
  npm --prefix web exec tsx scripts/community-backfill-postgres.ts -- [options]

Options:
  --dry-run              Read Firestore and report counts only. Default.
  --apply                Write to Postgres using idempotent upserts.
  --stock=CODE           Restrict to a stock code. Repeatable.
  --max-stocks=N         Restrict stock_communities processing to first N docs.
  --env-file=PATH        Load this env file before .env.local/.env.
  --skip-votes           Skip top-level community_votes.
  --skip-reports         Skip top-level community_reports.
`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);
  if (args.envFile) {
    loadDotenv({ path: args.envFile, quiet: true });
  }
  loadDotenv({ path: ".env.local", quiet: true });
  loadDotenv({ path: ".env", quiet: true });
  const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

  if (args.apply && !databaseUrl) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required");
  }

  const pool =
    args.apply && databaseUrl
      ? new Pool({
          connectionString: databaseUrl,
          max: 3,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        })
      : null;

  try {
    await backfillCommunityToPostgres({
      firestore: adminDb as FirestoreDbLike,
      db: pool ?? dryRunDb(),
      apply: args.apply,
      stocks: args.stocks,
      maxStocks: args.maxStocks,
      includeVotes: args.includeVotes,
      includeReports: args.includeReports,
      logger: console,
    });
  } finally {
    await pool?.end();
  }
}

function dryRunDb(): CommunityBackfillDb {
  return {
    async query() {
      throw new Error("dry-run database client should not be used");
    },
  };
}

if (
  process.env.JEST_WORKER_ID === undefined &&
  process.argv[1]?.endsWith("community-backfill-postgres.ts")
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
