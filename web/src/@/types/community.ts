export type CommunityThreadType =
  | "bull"
  | "bear"
  | "catalyst"
  | "question"
  | "news_reaction";

export type CommunityStatus = "active" | "hidden" | "deleted" | "needs_review";

export interface CommunityAuthorSnapshot {
  /** Internal ownership identity. Never serialize this snapshot to public clients. */
  userId: string;
  displayName: string;
  handle?: string;
  avatarUrl?: string;
  trustScore?: number;
}

export interface CommunitySourceLink {
  label: string;
  url: string;
}

export interface CommunityThread {
  id: string;
  stockCode: string;
  type: CommunityThreadType;
  title: string;
  body: string;
  score: number;
  commentCount: number;
  sourceCount: number;
  highSignal: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  status?: CommunityStatus;
  author?: CommunityAuthorSnapshot;
  sources?: CommunitySourceLink[];
}

export interface CommunityComment {
  id: string;
  stockCode: string;
  threadId: string;
  body: string;
  score: number;
  replyCount: number;
  createdAt: Date;
  updatedAt: Date;
  status?: CommunityStatus;
  author?: CommunityAuthorSnapshot;
}

export interface CommunityPulseItem {
  id: string;
  stockCode: string;
  body: string;
  score: number;
  replyCount: number;
  createdAt: Date;
  updatedAt: Date;
  status?: CommunityStatus;
  author?: CommunityAuthorSnapshot;
}

/** Intentionally excludes authentication IDs and provider profile fields. */
export interface PublicCommunityAuthor {
  displayName: string;
}

export type PublicCommunityThread = Omit<CommunityThread, "author"> & {
  author?: PublicCommunityAuthor;
};

export type PublicCommunityComment = Omit<CommunityComment, "author"> & {
  author?: PublicCommunityAuthor;
};

export type PublicCommunityPulseItem = Omit<CommunityPulseItem, "author"> & {
  author?: PublicCommunityAuthor;
};

export interface CommunityModerationResult {
  normalizedText: string;
  status: CommunityStatus;
  reasons: string[];
}

export interface CommunitySummaryInput {
  threads: CommunityThread[];
  pulse: CommunityPulseItem[];
  stockCode?: string;
}

export interface CommunityOverviewSummary {
  headline: string;
  subheadline: string;
  ctaLabel: string;
  threadCount: number;
  pulseCount: number;
  topThread?: Pick<
    CommunityThread,
    "id" | "title" | "commentCount" | "sourceCount" | "lastActivityAt"
  >;
  latestActivityAt?: Date;
}
