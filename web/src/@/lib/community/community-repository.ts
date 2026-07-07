import { firestoreCommunityStore } from "./firestore-community";
import {
  isPostgresCommunityConfigured,
  postgresCommunityStore,
} from "./postgres-community";
import { type CommunityStore } from "./community-store";

let warnedMissingPostgresConfig = false;

export function getCommunityStore(): CommunityStore {
  if (process.env.COMMUNITY_STORE_DRIVER?.toLowerCase() === "postgres") {
    if (isPostgresCommunityConfigured()) {
      return postgresCommunityStore;
    }

    if (!warnedMissingPostgresConfig) {
      warnedMissingPostgresConfig = true;
      console.warn(
        "COMMUNITY_STORE_DRIVER=postgres requested but DATABASE_URL/POSTGRES_URL is not set; falling back to Firestore community store",
      );
    }
  }

  return firestoreCommunityStore;
}

export function getStockCommunitySummary(stockCode: string) {
  return getCommunityStore().getStockCommunitySummary(stockCode);
}

export function listCommunityThreads(stockCode: string) {
  return getCommunityStore().listCommunityThreads(stockCode);
}

export function getCommunityThread(stockCode: string, threadId: string) {
  return getCommunityStore().getCommunityThread(stockCode, threadId);
}

export function listCommunityPulseItems(stockCode: string) {
  return getCommunityStore().listCommunityPulseItems(stockCode);
}

export function listCommunityComments(stockCode: string, threadId: string) {
  return getCommunityStore().listCommunityComments(stockCode, threadId);
}

export function listCommunityPulseReplies(stockCode: string, pulseId: string) {
  return getCommunityStore().listCommunityPulseReplies(stockCode, pulseId);
}

export function createCommunityThread(
  input: Parameters<CommunityStore["createCommunityThread"]>[0],
) {
  return getCommunityStore().createCommunityThread(input);
}

export function createCommunityComment(
  input: Parameters<CommunityStore["createCommunityComment"]>[0],
) {
  return getCommunityStore().createCommunityComment(input);
}

export function createCommunityPulseItem(
  input: Parameters<CommunityStore["createCommunityPulseItem"]>[0],
) {
  return getCommunityStore().createCommunityPulseItem(input);
}

export function createCommunityPulseReply(
  input: Parameters<CommunityStore["createCommunityPulseReply"]>[0],
) {
  return getCommunityStore().createCommunityPulseReply(input);
}

export function createCommunityVote(
  input: Parameters<CommunityStore["createCommunityVote"]>[0],
) {
  return getCommunityStore().createCommunityVote(input);
}

export function createCommunityReport(
  input: Parameters<CommunityStore["createCommunityReport"]>[0],
) {
  return getCommunityStore().createCommunityReport(input);
}
