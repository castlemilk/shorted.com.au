import {
  rankPulseItems,
  rankResearchThreads,
} from "~/@/lib/community/ranking";
import {
  type CommunityPulseItem,
  type CommunityThread,
} from "~/@/types/community";

describe("rankResearchThreads", () => {
  it("prefers source-backed, higher-score threads over unsupported threads", () => {
    const ranked = rankResearchThreads([
      {
        id: "low",
        stockCode: "BHP",
        type: "question",
        title: "Low signal thread",
        body: "Should I be worried?",
        score: 12,
        commentCount: 1,
        sourceCount: 0,
        highSignal: false,
        createdAt: new Date("2026-04-10T08:00:00Z"),
        updatedAt: new Date("2026-04-10T08:00:00Z"),
        lastActivityAt: new Date("2026-04-10T08:00:00Z"),
      } as CommunityThread,
      {
        id: "high",
        stockCode: "BHP",
        type: "bull",
        title: "High signal thread",
        body: "Three sources support the thesis.",
        score: 8,
        commentCount: 4,
        sourceCount: 3,
        highSignal: true,
        createdAt: new Date("2026-04-10T08:00:00Z"),
        updatedAt: new Date("2026-04-10T08:00:00Z"),
        lastActivityAt: new Date("2026-04-10T08:00:00Z"),
      } as CommunityThread,
    ]);

    expect(ranked[0]?.id).toBe("high");
  });
});

describe("rankPulseItems", () => {
  it("keeps recency dominant for pulse ordering", () => {
    const ranked = rankPulseItems([
      {
        id: "old",
        stockCode: "BHP",
        body: "The room is already pricing this in.",
        score: 20,
        replyCount: 6,
        createdAt: new Date("2026-04-10T08:00:00Z"),
        updatedAt: new Date("2026-04-10T08:00:00Z"),
      } as CommunityPulseItem,
      {
        id: "new",
        stockCode: "BHP",
        body: "Broker downgrade just hit the tape.",
        score: 1,
        replyCount: 0,
        createdAt: new Date("2026-04-11T08:00:00Z"),
        updatedAt: new Date("2026-04-11T08:00:00Z"),
      } as CommunityPulseItem,
    ]);

    expect(ranked[0]?.id).toBe("new");
  });
});
