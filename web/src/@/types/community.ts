export type CommunityThreadType =
  | "bull"
  | "bear"
  | "catalyst"
  | "question"
  | "news_reaction";

export type CommunityStatus = "active" | "hidden" | "deleted" | "needs_review";

export interface CommunityAuthorSnapshot {
  userId: string;
  displayName: string;
  handle?: string;
  avatarUrl?: string;
  trustScore?: number;
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
