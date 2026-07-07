import {
  type CommunityAuthorSnapshot,
  type CommunityComment,
  type CommunityOverviewSummary,
  type CommunityPulseItem,
  type CommunitySourceLink,
  type CommunityStatus,
  type CommunityThread,
} from "~/@/types/community";

export interface CreateCommunityThreadInput {
  stockCode: string;
  type: CommunityThread["type"];
  title: string;
  body: string;
  author: CommunityAuthorSnapshot;
  status: CommunityStatus;
  sources?: CommunitySourceLink[];
}

export interface CreateCommunityCommentInput {
  stockCode: string;
  threadId: string;
  body: string;
  author: CommunityAuthorSnapshot;
  status: CommunityStatus;
}

export interface CreateCommunityPulseItemInput {
  stockCode: string;
  body: string;
  author: CommunityAuthorSnapshot;
  status: CommunityStatus;
}

export interface CreateCommunityPulseReplyInput {
  stockCode: string;
  pulseId: string;
  body: string;
  author: CommunityAuthorSnapshot;
  status: CommunityStatus;
}

export interface CreateCommunityVoteInput {
  stockCode: string;
  targetType: "thread" | "comment" | "pulse" | "pulse_reply";
  targetId: string;
  value: 1 | -1;
  userId: string;
}

export interface CreateCommunityReportInput {
  stockCode: string;
  targetType: "thread" | "comment" | "pulse" | "pulse_reply";
  targetId: string;
  reason: string;
  details?: string;
  userId: string;
}

export interface CommunityVote {
  id: string;
  stockCode: string;
  targetType: CreateCommunityVoteInput["targetType"];
  targetId: string;
  value: 1 | -1;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommunityReport {
  id: string;
  stockCode: string;
  targetType: CreateCommunityReportInput["targetType"];
  targetId: string;
  reason: string;
  details?: string;
  userId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommunityStore {
  getStockCommunitySummary(
    stockCode: string,
  ): Promise<CommunityOverviewSummary>;
  listCommunityThreads(stockCode: string): Promise<CommunityThread[]>;
  getCommunityThread(
    stockCode: string,
    threadId: string,
  ): Promise<CommunityThread | null>;
  listCommunityPulseItems(stockCode: string): Promise<CommunityPulseItem[]>;
  listCommunityComments(
    stockCode: string,
    threadId: string,
  ): Promise<CommunityComment[]>;
  listCommunityPulseReplies(
    stockCode: string,
    pulseId: string,
  ): Promise<CommunityComment[]>;
  createCommunityThread(
    input: CreateCommunityThreadInput,
  ): Promise<CommunityThread>;
  createCommunityComment(
    input: CreateCommunityCommentInput,
  ): Promise<CommunityComment>;
  createCommunityPulseItem(
    input: CreateCommunityPulseItemInput,
  ): Promise<CommunityPulseItem>;
  createCommunityPulseReply(
    input: CreateCommunityPulseReplyInput,
  ): Promise<CommunityComment>;
  createCommunityVote(input: CreateCommunityVoteInput): Promise<CommunityVote>;
  createCommunityReport(
    input: CreateCommunityReportInput,
  ): Promise<CommunityReport>;
}
