import {
  type CommunityAuthorSnapshot,
  type CommunityComment,
  type CommunityPulseItem,
  type CommunityThread,
  type PublicCommunityAuthor,
  type PublicCommunityComment,
  type PublicCommunityPulseItem,
  type PublicCommunityThread,
} from "~/@/types/community";

export const COMMUNITY_MEMBER_NAME = "Community member";

// NFKC also exposes full-width email separators. Reject controls/bidi markers,
// markup and contact URLs instead of trying to turn them into a public name.
const PRIVATE_OR_UNSAFE_NAME =
  /[@<>\p{Cc}\p{Cf}]|(?:https?|mailto|javascript|data):/iu;

function publicDisplayName(value: unknown, privateUserId?: string): string {
  if (typeof value !== "string") return COMMUNITY_MEMBER_NAME;
  const name = value.normalize("NFKC").trim();
  if (
    !name ||
    name.length > 80 ||
    name === privateUserId ||
    PRIVATE_OR_UNSAFE_NAME.test(name)
  ) {
    return COMMUNITY_MEMBER_NAME;
  }
  return name.replace(/\s+/gu, " ");
}

/** Keep ownership server-side; never promote an authentication email to a name. */
export function communityAuthorSnapshot(user: {
  id: string;
  name?: string | null;
}): CommunityAuthorSnapshot {
  return {
    userId: user.id,
    displayName: publicDisplayName(user.name, user.id),
  };
}

/**
 * A public label is not a profile/verification promise. Handles, provider
 * avatars (which can contain account IDs or tracking URLs) and trust scores
 * need an explicit public-profile contract before they can be exposed.
 * This is also applied to legacy records at every response boundary, without
 * modifying their private ownership or historical snapshots.
 */
function publicAuthor(
  author: CommunityAuthorSnapshot | PublicCommunityAuthor | undefined,
): PublicCommunityAuthor | undefined {
  if (!author) return undefined;
  return {
    displayName: publicDisplayName(
      author.displayName,
      "userId" in author ? author.userId : undefined,
    ),
  };
}

// Use explicit DTOs, not spreads: new private storage fields must not silently
// become part of an API response or a React Server Component payload.
export function toPublicCommunityThread(
  thread: CommunityThread | PublicCommunityThread,
): PublicCommunityThread {
  return {
    id: thread.id,
    stockCode: thread.stockCode,
    type: thread.type,
    title: thread.title,
    body: thread.body,
    score: thread.score,
    commentCount: thread.commentCount,
    sourceCount: thread.sourceCount,
    highSignal: thread.highSignal,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastActivityAt: thread.lastActivityAt,
    status: thread.status,
    author: publicAuthor(thread.author),
    sources: thread.sources?.map(({ label, url }) => ({ label, url })),
  };
}

export function toPublicCommunityComment(
  comment: CommunityComment | PublicCommunityComment,
): PublicCommunityComment {
  return {
    id: comment.id,
    stockCode: comment.stockCode,
    threadId: comment.threadId,
    body: comment.body,
    score: comment.score,
    replyCount: comment.replyCount,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    status: comment.status,
    author: publicAuthor(comment.author),
  };
}

export function toPublicCommunityPulseItem(
  item: CommunityPulseItem | PublicCommunityPulseItem,
): PublicCommunityPulseItem {
  return {
    id: item.id,
    stockCode: item.stockCode,
    body: item.body,
    score: item.score,
    replyCount: item.replyCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    status: item.status,
    author: publicAuthor(item.author),
  };
}
