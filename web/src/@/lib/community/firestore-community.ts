import { adminDb } from "~/@/lib/firebase-admin";
import {
  type CommunityAuthorSnapshot,
  type CommunityComment,
  type CommunityOverviewSummary,
  type CommunityPulseItem,
  type CommunityThread,
} from "~/@/types/community";
import { rankPulseItems, rankResearchThreads } from "~/@/lib/community/ranking";
import { buildCommunitySummary } from "~/@/lib/community/summary";

type FirestoreValue =
  | Date
  | string
  | number
  | { toDate?: () => Date }
  | null
  | undefined;

type FirestoreDocSnapshot = {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
};

type FirestoreQuerySnapshot = {
  docs: FirestoreDocSnapshot[];
};

interface CreateCommunityThreadInput {
  stockCode: string;
  type: CommunityThread["type"];
  title: string;
  body: string;
  author: CommunityAuthorSnapshot;
  status: CommunityThread["status"];
  sources?: CommunityThread["sources"];
}

interface CreateCommunityCommentInput {
  stockCode: string;
  threadId: string;
  body: string;
  author: CommunityAuthorSnapshot;
  status: CommunityComment["status"];
}

interface CreateCommunityPulseItemInput {
  stockCode: string;
  body: string;
  author: CommunityAuthorSnapshot;
  status: CommunityPulseItem["status"];
}

interface CreateCommunityPulseReplyInput {
  stockCode: string;
  pulseId: string;
  body: string;
  author: CommunityAuthorSnapshot;
  status: CommunityComment["status"];
}

interface CreateCommunityVoteInput {
  stockCode: string;
  targetType: "thread" | "comment" | "pulse" | "pulse_reply";
  targetId: string;
  value: 1 | -1;
  userId: string;
}

interface CreateCommunityReportInput {
  stockCode: string;
  targetType: "thread" | "comment" | "pulse" | "pulse_reply";
  targetId: string;
  reason: string;
  details?: string;
  userId: string;
}

function communityDoc(stockCode: string) {
  return adminDb.collection("stock_communities").doc(stockCode.toUpperCase());
}

function toDate(value: FirestoreValue): Date {
  if (value instanceof Date) {
    return value;
  }

  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    return value.toDate();
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date(0);
}

function mapSummary(
  data: Record<string, unknown>,
): CommunityOverviewSummary {
  const topThreadData =
    data.topThread && typeof data.topThread === "object"
      ? (data.topThread as Record<string, unknown>)
      : undefined;

  return {
    headline: String(data.headline ?? "Open community"),
    subheadline: String(data.subheadline ?? ""),
    ctaLabel: String(data.ctaLabel ?? "Open community"),
    threadCount: Number(data.threadCount ?? 0),
    pulseCount: Number(data.pulseCount ?? 0),
    topThread: topThreadData
      ? {
          id: String(topThreadData.id ?? ""),
          title: String(topThreadData.title ?? ""),
          commentCount: Number(topThreadData.commentCount ?? 0),
          sourceCount: Number(topThreadData.sourceCount ?? 0),
          lastActivityAt: toDate(topThreadData.lastActivityAt as FirestoreValue),
        }
      : undefined,
    latestActivityAt: data.latestActivityAt
      ? toDate(data.latestActivityAt as FirestoreValue)
      : undefined,
  };
}

function mapThread(snapshot: FirestoreDocSnapshot): CommunityThread {
  const data = snapshot.data() ?? {};

  return {
    id: snapshot.id,
    stockCode: String(data.stockCode ?? ""),
    type: (data.type ?? "question") as CommunityThread["type"],
    title: String(data.title ?? ""),
    body: String(data.body ?? ""),
    score: Number(data.score ?? 0),
    commentCount: Number(data.commentCount ?? 0),
    sourceCount: Number(data.sourceCount ?? 0),
    highSignal: Boolean(data.highSignal),
    createdAt: toDate(data.createdAt as FirestoreValue),
    updatedAt: toDate(data.updatedAt as FirestoreValue),
    lastActivityAt: toDate(data.lastActivityAt as FirestoreValue),
    status: (data.status ?? "active") as CommunityThread["status"],
    author:
      data.author && typeof data.author === "object"
        ? {
            userId: String(
              (data.author as Record<string, unknown>).userId ?? "",
            ),
            displayName: String(
              (data.author as Record<string, unknown>).displayName ?? "",
            ),
            handle:
              (data.author as Record<string, unknown>).handle !== undefined
                ? String((data.author as Record<string, unknown>).handle)
                : undefined,
            avatarUrl:
              (data.author as Record<string, unknown>).avatarUrl !== undefined
                ? String((data.author as Record<string, unknown>).avatarUrl)
                : undefined,
            trustScore:
              (data.author as Record<string, unknown>).trustScore !== undefined
                ? Number((data.author as Record<string, unknown>).trustScore)
                : undefined,
          }
        : undefined,
    sources: Array.isArray(data.sources)
      ? data.sources
          .filter(
            (source): source is Record<string, unknown> =>
              typeof source === "object" && source !== null,
          )
          .map((source) => ({
            label: String(source.label ?? ""),
            url: String(source.url ?? ""),
          }))
      : undefined,
  };
}

function mapPulseItem(snapshot: FirestoreDocSnapshot): CommunityPulseItem {
  const data = snapshot.data() ?? {};

  return {
    id: snapshot.id,
    stockCode: String(data.stockCode ?? ""),
    body: String(data.body ?? ""),
    score: Number(data.score ?? 0),
    replyCount: Number(data.replyCount ?? 0),
    createdAt: toDate(data.createdAt as FirestoreValue),
    updatedAt: toDate(data.updatedAt as FirestoreValue),
    status: (data.status ?? "active") as CommunityPulseItem["status"],
    author:
      data.author && typeof data.author === "object"
        ? {
            userId: String(
              (data.author as Record<string, unknown>).userId ?? "",
            ),
            displayName: String(
              (data.author as Record<string, unknown>).displayName ?? "",
            ),
            handle:
              (data.author as Record<string, unknown>).handle !== undefined
                ? String((data.author as Record<string, unknown>).handle)
                : undefined,
            avatarUrl:
              (data.author as Record<string, unknown>).avatarUrl !== undefined
                ? String((data.author as Record<string, unknown>).avatarUrl)
                : undefined,
            trustScore:
              (data.author as Record<string, unknown>).trustScore !== undefined
                ? Number((data.author as Record<string, unknown>).trustScore)
                : undefined,
          }
        : undefined,
  };
}

function mapComment(snapshot: FirestoreDocSnapshot): CommunityComment {
  const data = snapshot.data() ?? {};

  return {
    id: snapshot.id,
    stockCode: String(data.stockCode ?? ""),
    threadId: String(data.threadId ?? ""),
    body: String(data.body ?? ""),
    score: Number(data.score ?? 0),
    replyCount: Number(data.replyCount ?? 0),
    createdAt: toDate(data.createdAt as FirestoreValue),
    updatedAt: toDate(data.updatedAt as FirestoreValue),
    status: (data.status ?? "active") as CommunityComment["status"],
    author:
      data.author && typeof data.author === "object"
        ? {
            userId: String(
              (data.author as Record<string, unknown>).userId ?? "",
            ),
            displayName: String(
              (data.author as Record<string, unknown>).displayName ?? "",
            ),
            handle:
              (data.author as Record<string, unknown>).handle !== undefined
                ? String((data.author as Record<string, unknown>).handle)
                : undefined,
            avatarUrl:
              (data.author as Record<string, unknown>).avatarUrl !== undefined
                ? String((data.author as Record<string, unknown>).avatarUrl)
                : undefined,
            trustScore:
              (data.author as Record<string, unknown>).trustScore !== undefined
                ? Number((data.author as Record<string, unknown>).trustScore)
                : undefined,
          }
        : undefined,
  };
}

export async function getStockCommunitySummary(
  stockCode: string,
): Promise<CommunityOverviewSummary> {
  const summaryDoc = (await communityDoc(stockCode).get()) as FirestoreDocSnapshot;

  if (summaryDoc.exists) {
    return mapSummary(summaryDoc.data() ?? {});
  }

  const [threads, pulse] = await Promise.all([
    listCommunityThreads(stockCode),
    listCommunityPulseItems(stockCode),
  ]);

  return buildCommunitySummary({ stockCode, threads, pulse });
}

export async function listCommunityThreads(
  stockCode: string,
): Promise<CommunityThread[]> {
  const snapshot = (await communityDoc(stockCode)
    .collection("threads")
    .where("status", "==", "active")
    .get()) as FirestoreQuerySnapshot;

  return rankResearchThreads(snapshot.docs.map(mapThread));
}

export async function getCommunityThread(
  stockCode: string,
  threadId: string,
): Promise<CommunityThread | null> {
  const snapshot = (await communityDoc(stockCode)
    .collection("threads")
    .doc(threadId)
    .get()) as FirestoreDocSnapshot;

  return snapshot.exists ? mapThread(snapshot) : null;
}

export async function listCommunityPulseItems(
  stockCode: string,
): Promise<CommunityPulseItem[]> {
  const snapshot = (await communityDoc(stockCode)
    .collection("pulse")
    .where("status", "==", "active")
    .get()) as FirestoreQuerySnapshot;

  return rankPulseItems(snapshot.docs.map(mapPulseItem));
}

export async function listCommunityComments(
  stockCode: string,
  threadId: string,
): Promise<CommunityComment[]> {
  const snapshot = (await communityDoc(stockCode)
    .collection("threads")
    .doc(threadId)
    .collection("comments")
    .where("status", "==", "active")
    .get()) as FirestoreQuerySnapshot;

  return snapshot.docs
    .map(mapComment)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function listCommunityPulseReplies(
  stockCode: string,
  pulseId: string,
): Promise<CommunityComment[]> {
  const snapshot = (await communityDoc(stockCode)
    .collection("pulse")
    .doc(pulseId)
    .collection("replies")
    .where("status", "==", "active")
    .get()) as FirestoreQuerySnapshot;

  return snapshot.docs
    .map(mapComment)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function createCommunityThread({
  stockCode,
  type,
  title,
  body,
  author,
  status,
  sources,
}: CreateCommunityThreadInput): Promise<CommunityThread> {
  const now = new Date();
  const record: Omit<CommunityThread, "id"> = {
    stockCode,
    type,
    title,
    body,
    score: 0,
    commentCount: 0,
    sourceCount: sources?.length ?? 0,
    highSignal: (sources?.length ?? 0) >= 2,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    status,
    author,
    sources,
  };

  const reference = await communityDoc(stockCode).collection("threads").add(record);

  return {
    id: reference.id,
    ...record,
  };
}

export async function createCommunityComment({
  stockCode,
  threadId,
  body,
  author,
  status,
}: CreateCommunityCommentInput): Promise<CommunityComment> {
  const now = new Date();
  const record: Omit<CommunityComment, "id"> = {
    stockCode,
    threadId,
    body,
    score: 0,
    replyCount: 0,
    createdAt: now,
    updatedAt: now,
    status,
    author,
  };

  const reference = await communityDoc(stockCode)
    .collection("threads")
    .doc(threadId)
    .collection("comments")
    .add(record);

  return {
    id: reference.id,
    ...record,
  };
}

export async function createCommunityPulseItem({
  stockCode,
  body,
  author,
  status,
}: CreateCommunityPulseItemInput): Promise<CommunityPulseItem> {
  const now = new Date();
  const record: Omit<CommunityPulseItem, "id"> = {
    stockCode,
    body,
    score: 0,
    replyCount: 0,
    createdAt: now,
    updatedAt: now,
    status,
    author,
  };

  const reference = await communityDoc(stockCode).collection("pulse").add(record);

  return {
    id: reference.id,
    ...record,
  };
}

export async function createCommunityPulseReply({
  stockCode,
  pulseId,
  body,
  author,
  status,
}: CreateCommunityPulseReplyInput): Promise<CommunityComment> {
  const now = new Date();
  const record: Omit<CommunityComment, "id"> = {
    stockCode,
    threadId: pulseId,
    body,
    score: 0,
    replyCount: 0,
    createdAt: now,
    updatedAt: now,
    status,
    author,
  };

  const reference = await communityDoc(stockCode)
    .collection("pulse")
    .doc(pulseId)
    .collection("replies")
    .add(record);

  return {
    id: reference.id,
    ...record,
  };
}

export async function createCommunityVote({
  stockCode,
  targetType,
  targetId,
  value,
  userId,
}: CreateCommunityVoteInput) {
  const now = new Date();
  const record = {
    stockCode,
    targetType,
    targetId,
    value,
    userId,
    createdAt: now,
    updatedAt: now,
  };

  const reference = await adminDb.collection("community_votes").add(record);

  return {
    id: reference.id,
    ...record,
  };
}

export async function createCommunityReport({
  stockCode,
  targetType,
  targetId,
  reason,
  details,
  userId,
}: CreateCommunityReportInput) {
  const now = new Date();
  const record = {
    stockCode,
    targetType,
    targetId,
    reason,
    details,
    userId,
    createdAt: now,
    updatedAt: now,
    status: "open",
  };

  const reference = await adminDb.collection("community_reports").add(record);

  return {
    id: reference.id,
    ...record,
  };
}
