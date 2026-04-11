import {
  type CommunityPulseItem,
  type CommunityThread,
} from "~/@/types/community";

function computeResearchThreadRank(thread: CommunityThread): number {
  return (
    thread.score +
    thread.commentCount * 0.5 +
    thread.sourceCount * 3 +
    (thread.highSignal ? 4 : 0)
  );
}

export function rankResearchThreads(
  threads: CommunityThread[],
): CommunityThread[] {
  return [...threads].sort((a, b) => {
    const rankDifference =
      computeResearchThreadRank(b) - computeResearchThreadRank(a);

    if (rankDifference !== 0) {
      return rankDifference;
    }

    return b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
  });
}

export function rankPulseItems(items: CommunityPulseItem[]): CommunityPulseItem[] {
  return [...items].sort((a, b) => {
    const createdAtDifference = b.createdAt.getTime() - a.createdAt.getTime();

    if (createdAtDifference !== 0) {
      return createdAtDifference;
    }

    const scoreDifference = b.score - a.score;
    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    return b.replyCount - a.replyCount;
  });
}
