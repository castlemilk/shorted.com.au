import { describe, it, expect } from "vitest";
import { hasNewDevelopment } from "./editor.js";
import type { SignalBoardRow } from "./journalism.js";

const baseRow = (over: Partial<SignalBoardRow> = {}): SignalBoardRow => ({
  stockCode: "BHP",
  name: "BHP",
  industry: "Materials",
  lastTakeDate: "2026-05-20",
  recentPriceSensitiveHeadlines: [],
  signals: {
    shortSlope90d: 0, shortSlope30d: 0, shortSlope7d: 0,
    currentShortPct: 5, shortPct90dAvg: 5, shortPctChange90d: 0,
    shortPctMaxIn90d: 6, shortPctMinIn90d: 4,
    currentPrice: 40, priceChange1m: 0, priceChange3m: 0, priceChange6m: 0, priceChange12m: 0,
    priceShortsCorrelation30d: 0,
    newsArticlesLast30d: 0, newsArticlesLast7d: 0, priceSensitiveLast30d: 0,
    sentimentMix: { positive: 0, negative: 0, neutral: 0 }, sentimentTrendLast30d: "n/a",
    directorTradesLast90d: 0, directorNetValueLast90d: 0, directorMostRecentDate: null,
    peerSectorAverageShort: 5, peerRelative: "at", topRecentEvents: [],
  },
  ...over,
});

describe("hasNewDevelopment", () => {
  it("is true when never covered before", () => {
    expect(hasNewDevelopment(baseRow({ lastTakeDate: null }))).toBe(true);
  });

  it("is true when a price-sensitive headline landed after the last take", () => {
    const row = baseRow({
      lastTakeDate: "2026-05-20",
      recentPriceSensitiveHeadlines: [{ date: "2026-05-25", headline: "ASIC probe" }],
    });
    expect(hasNewDevelopment(row)).toBe(true);
  });

  it("is true on a short-position regime change since the last take", () => {
    const row = baseRow({ lastTakeDate: "2026-05-20", signals: { ...baseRow().signals, shortPctChange90d: 3.5 } });
    expect(hasNewDevelopment(row)).toBe(true);
  });

  it("is true on a fresh director trade after the last take", () => {
    const row = baseRow({ lastTakeDate: "2026-05-20", signals: { ...baseRow().signals, directorMostRecentDate: "2026-05-28" } });
    expect(hasNewDevelopment(row)).toBe(true);
  });

  it("is false when nothing material happened since the last take", () => {
    expect(hasNewDevelopment(baseRow())).toBe(false);
  });
});
