import {
  type CommunityOverviewSummary,
  type CommunitySummaryInput,
} from "~/@/types/community";
import { rankPulseItems, rankResearchThreads } from "~/@/lib/community/ranking";

export function buildCommunitySummary({
  threads,
  pulse,
  stockCode,
}: CommunitySummaryInput): CommunityOverviewSummary {
  const rankedThreads = rankResearchThreads(threads);
  const rankedPulse = rankPulseItems(pulse);
  const topThread = rankedThreads[0];
  const latestPulse = rankedPulse[0];

  if (!topThread && !latestPulse) {
    return {
      headline: stockCode
        ? `Be the first to discuss ${stockCode}`
        : "Be the first to discuss this stock",
      subheadline:
        "Start the research thread, post a catalyst, or add the first pulse update.",
      ctaLabel: "Open community",
      threadCount: 0,
      pulseCount: 0,
    };
  }

  const latestActivityCandidates = [
    topThread?.lastActivityAt,
    latestPulse?.updatedAt,
  ].filter((value): value is Date => value instanceof Date);

  return {
    headline: topThread
      ? `${topThread.title}`
      : `${pulse.length} recent pulse updates`,
    subheadline: topThread
      ? `${threads.length} threads and ${pulse.length} pulse updates live now`
      : "See what traders are reacting to right now.",
    ctaLabel: "Join the discussion",
    threadCount: threads.length,
    pulseCount: pulse.length,
    topThread: topThread
      ? {
          id: topThread.id,
          title: topThread.title,
          commentCount: topThread.commentCount,
          sourceCount: topThread.sourceCount,
          lastActivityAt: topThread.lastActivityAt,
        }
      : undefined,
    latestActivityAt:
      latestActivityCandidates.length > 0
        ? new Date(
            Math.max(...latestActivityCandidates.map((value) => value.getTime())),
          )
        : undefined,
  };
}
