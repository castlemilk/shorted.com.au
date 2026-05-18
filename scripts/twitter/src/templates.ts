// Tweet text generators. Each takes raw data, returns either a single
// tweet string or an array of strings for a thread. All outputs are
// truncated / packed to fit within 280 chars per tweet.

import {
  getDirectorTrades,
  getMarketNews,
  getStockHistory,
  getTopShorts,
  type TopShortsItem,
} from "./shorted-api.js";

const SITE = "shorted.com.au";

const sentimentEmoji = (s?: string): string => {
  switch ((s ?? "").toLowerCase()) {
    case "positive":
      return "🟢";
    case "negative":
      return "🔴";
    default:
      return "⚪";
  }
};

const fmtPct = (n: number, decimals = 2): string => `${n.toFixed(decimals)}%`;

const stocksWithChange = async (
  current: TopShortsItem[],
): Promise<Array<TopShortsItem & { wowChange: number | null }>> => {
  // Pull recent history for each to compute week-on-week change.
  // Restored after PR #139 + #140 fixed the edge-worker hot-cache bug
  // that was causing per-stock GetStockData calls to return the same
  // (first-cached) stock's data regardless of the requested code.
  const out: Array<TopShortsItem & { wowChange: number | null }> = [];
  for (const stock of current) {
    let wowChange: number | null = null;
    try {
      const series = await getStockHistory(stock.productCode, "1m");
      if (series && series.points.length >= 2) {
        const latest = series.points[series.points.length - 1]!;
        const targetMs = latest.date.getTime() - 7 * 86400000;
        let prior = series.points[0]!;
        for (const p of series.points) {
          if (
            Math.abs(p.date.getTime() - targetMs) <
            Math.abs(prior.date.getTime() - targetMs)
          ) {
            prior = p;
          }
        }
        wowChange = latest.shortPosition - prior.shortPosition;
      }
    } catch {
      // ignore — leave wowChange null
    }
    out.push({ ...stock, wowChange });
  }
  return out;
};

// ============================================================
// Daily Top Shorts — 1 tweet
// ============================================================

export async function buildDailyShortsTweet(): Promise<string> {
  const raw = await getTopShorts({ period: "1y", limit: 5, summaryOnly: true });
  if (raw.length === 0) {
    throw new Error("No top-shorts data available");
  }
  const enriched = await stocksWithChange(raw);

  const lines = enriched.map((s, i) => {
    const pct = fmtPct(s.latestShortPosition ?? 0);
    const arrow =
      s.wowChange === null
        ? ""
        : s.wowChange > 0.05
          ? ` ↑${s.wowChange.toFixed(2)}`
          : s.wowChange < -0.05
            ? ` ↓${Math.abs(s.wowChange).toFixed(2)}`
            : " =";
    return `${i + 1}. ${s.productCode}  ${pct}${arrow}`;
  });

  // Rotate the opener so the daily cron doesn't post the same string
  // every weekday. Picked by day-of-year so it's deterministic per run
  // but varies across the week. PERSONA.md: variance over rhythm.
  const top = enriched[0]!;
  const topPct = (top.latestShortPosition ?? 0).toFixed(2);
  const openers = [
    "Most shorted ASX stocks today:",
    "Top of the ASIC short-position table:",
    `${top.productCode} keeps the top spot. Today's table:`,
    "Today's top-5 shorted (ASIC, T+4):",
    `${topPct}% of ${top.productCode} sold short. The rest of the leaderboard:`,
    "Where the borrow desks are busy this morning:",
    "Today's most-shorted, in order:",
  ];
  const doy = Math.floor(
    (Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86400000,
  );
  const opener = openers[doy % openers.length]!;

  return [
    opener,
    "",
    ...lines,
    "",
    `Source: ASIC (T+4). Live: ${SITE}/top`,
  ].join("\n");
}

// ============================================================
// Biggest Movers — 1 tweet (largest WoW change)
// ============================================================

export async function buildMoversTweet(): Promise<string> {
  const raw = await getTopShorts({ period: "1y", limit: 30, summaryOnly: true });
  const enriched = await stocksWithChange(raw);
  const movers = enriched
    .filter((s) => s.wowChange !== null)
    .sort((a, b) => Math.abs(b.wowChange ?? 0) - Math.abs(a.wowChange ?? 0))
    .slice(0, 3);
  if (movers.length === 0) {
    // Fallback: no WoW data, surface the top of the list.
    const raw5 = raw.slice(0, 4);
    const top = raw5[0]!;
    const others = raw5
      .slice(1)
      .map((m) => `${m.productCode} (${fmtPct(m.latestShortPosition ?? 0)})`)
      .join("  ·  ");
    return [
      `$${top.productCode} sits at the top of the ASX short-interest table at ${fmtPct(top.latestShortPosition ?? 0)}.`,
      "",
      `Also worth watching: ${others}`,
      "",
      `Live updates: ${SITE}/shorts/${top.productCode}`,
    ].join("\n");
  }

  const top = movers[0]!;
  const change = top.wowChange ?? 0;
  const direction = change > 0 ? "jumped" : "covered";
  const sign = change > 0 ? "+" : "";
  const others = movers
    .slice(1)
    .map((m) => {
      const c = m.wowChange ?? 0;
      const s = c > 0 ? "+" : "";
      return `${m.productCode} (${s}${c.toFixed(2)}%)`;
    })
    .join("  ·  ");

  return [
    `$${top.productCode} short interest ${direction} ${sign}${change.toFixed(2)}% this week.`,
    "",
    `Now: ${fmtPct(top.latestShortPosition ?? 0)} of shares outstanding shorted.`,
    "",
    `Other big movers: ${others}`,
    "",
    `Chart: ${SITE}/shorts/${top.productCode}`,
  ].join("\n");
}

// ============================================================
// Stock of the Day — 1 tweet on #1 most-shorted
// ============================================================

export async function buildStockOfTheDayTweet(): Promise<string> {
  const raw = await getTopShorts({ period: "1y", limit: 1, summaryOnly: true });
  if (raw.length === 0) throw new Error("No top-shorts data available");
  const top = raw[0]!;
  const pct = fmtPct(top.latestShortPosition ?? 0);

  return [
    `🏆 #1 most-shorted ASX stock: $${top.productCode}`,
    "",
    `${top.name}`,
    `Short interest: ${pct} of shares on issue`,
    "",
    `Sourced from official ASIC reports with T+4 delay.`,
    `Daily-updated chart: ${SITE}/shorts/${top.productCode}`,
  ].join("\n");
}

// ============================================================
// Weekly Digest — Thread (3 tweets)
// ============================================================

export async function buildWeeklyDigestThread(): Promise<string[]> {
  const raw = await getTopShorts({ period: "1y", limit: 10, summaryOnly: true });

  // Resolve current ISO week.
  const now = new Date();
  const target = new Date(now.valueOf());
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target.valueOf() - yearStart.valueOf()) / 86400000 + 1) / 7);
  const weekSlug = `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;

  const topThree = raw
    .slice(0, 3)
    .map((s) => `${s.productCode} ${fmtPct(s.latestShortPosition ?? 0)}`)
    .join("  ·  ");
  const nextFour = raw
    .slice(3, 7)
    .map((s) => `${s.productCode}`)
    .join("  ·  ");

  return [
    `ASX short selling — Week ${weekSlug} 📊\n\nFull thread + linked report below ⬇️`,
    `🔴 This week's top 3 shorted ASX stocks:\n\n${topThree}`,
    `👀 Other names with elevated short interest worth watching:\n\n${nextFour}`,
    `Full breakdown — narrative, sector heatmap, days-to-cover for every stock — at ${SITE}/reports/weekly/${weekSlug}`,
  ];
}

// ============================================================
// Breaking News — 1 tweet on most recent price-sensitive headline
// ============================================================

export async function buildBreakingNewsTweet(): Promise<string | null> {
  const news = await getMarketNews({ limit: 30, priceSensitiveOnly: true });
  if (news.length === 0) return null;
  const latest = news.find(
    (a) => a.stockCode && a.stockCode !== "MARKET",
  );
  if (!latest) return null;

  const emoji = sentimentEmoji(latest.sentiment);
  // Twitter wraps URLs to 23 chars; trim headline to fit alongside.
  const stockLine = `$${latest.stockCode} ${emoji}`;
  const sourceLine = `— via ${latest.source}`;
  const linkLine = `Full coverage: ${SITE}/shorts/${latest.stockCode}/news`;
  const overhead = stockLine.length + sourceLine.length + linkLine.length + 6; // line breaks
  const headlineBudget = 270 - overhead;
  const headline =
    latest.headline.length > headlineBudget
      ? latest.headline.slice(0, headlineBudget - 1) + "…"
      : latest.headline;

  return [stockLine, "", `"${headline}"`, "", sourceLine, "", linkLine].join("\n");
}

// ============================================================
// Insider Trade Alert — 1 tweet on largest recent director trade
// for a given stock (provide stockCode arg)
// ============================================================

export async function buildInsiderTradeTweet(
  stockCode: string,
): Promise<string | null> {
  const trades = await getDirectorTrades(stockCode, 20);
  if (trades.length === 0) return null;
  const largest = trades.sort(
    (a, b) => Number(b.totalValue ?? 0) - Number(a.totalValue ?? 0),
  )[0];
  if (!largest) return null;
  const value = Number(largest.totalValue ?? 0);
  if (value < 100_000) return null; // skip tiny trades

  const direction = largest.tradeType.toLowerCase() === "buy" ? "BUY 🟢" : "SELL 🔴";
  const fmtMoney = new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(value);

  return [
    `$${stockCode} insider ${direction}`,
    "",
    `${largest.directorName} disclosed a ${fmtMoney} ${largest.tradeType.toLowerCase()} on ${largest.tradeDate}.`,
    "",
    `Source: ASX Appendix 3Y.`,
    `History: ${SITE}/insider-trading/${stockCode}`,
  ].join("\n");
}
