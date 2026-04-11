import { adminDb } from "~/@/lib/firebase-admin";
import {
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
