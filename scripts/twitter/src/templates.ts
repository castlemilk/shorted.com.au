// Tweet text generators. Each takes raw data, returns either a single
// tweet string or an array of strings for a thread. All outputs are
// truncated / packed to fit within 280 chars per tweet.

import {
  findTakeForStockHeadline,
  getDirectorTrades,
  getMarketNews,
  getStockHistory,
  getTopShorts,
  type EditorialTake,
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
  const sign = change > 0 ? "+" : "";
  const abs = Math.abs(change).toFixed(2);
  const nowPct = fmtPct(top.latestShortPosition ?? 0);
  const code = top.productCode;
  const others = movers
    .slice(1)
    .map((m) => {
      const c = m.wowChange ?? 0;
      const s = c > 0 ? "+" : "";
      return `${m.productCode} (${s}${c.toFixed(2)}%)`;
    })
    .join("  ·  ");

  // PERSONA.md: movers = lower heat. The numbers do the work; flat
  // delivery makes the size of the move land harder. Rotate openers by
  // day-of-year so weekday cron-fired posts vary.
  const doy = Math.floor(
    (Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86400000,
  );

  const upOpeners = [
    [
      `$${code} short interest jumped +${abs}% this week. Now sitting at ${nowPct}.`,
      "",
      `Other movers: ${others}.`,
    ].join("\n"),

    [
      `+${abs}% in a week is the kind of move that doesn't happen by accident — $${code} is now at ${nowPct} shorted.`,
      "",
      `Also worth a look: ${others}.`,
    ].join("\n"),

    [
      `$${code} added ${abs}% to its short position over the past seven days. The current read is ${nowPct}.`,
      "",
      `Behind it: ${others}.`,
    ].join("\n"),
  ];

  const downOpeners = [
    [
      `$${code} just had ${abs}% of its short position covered. Now at ${nowPct}.`,
      "",
      `Other covers: ${others}.`,
    ].join("\n"),

    [
      `Covering of $${code} continued this week — ${sign}${change.toFixed(2)}% off the position, currently ${nowPct}.`,
      "",
      `Elsewhere: ${others}.`,
    ].join("\n"),

    [
      `$${code} short position dropped ${abs}% over the week. The borrow desk's interest in it has clearly softened.`,
      "",
      `Sitting at ${nowPct} now. Other movers: ${others}.`,
    ].join("\n"),
  ];

  const openers = change > 0 ? upOpeners : downOpeners;
  const body = openers[doy % openers.length]!;

  return [body, "", `${SITE}/shorts/${code}`].join("\n");
}

// ============================================================
// Stock of the Day — 1 tweet on #1 most-shorted
// ============================================================

export async function buildStockOfTheDayTweet(): Promise<string> {
  const raw = await getTopShorts({ period: "1y", limit: 1, summaryOnly: true });
  if (raw.length === 0) throw new Error("No top-shorts data available");
  const top = raw[0]!;
  const pct = fmtPct(top.latestShortPosition ?? 0);
  const code = top.productCode;
  const name = top.name;

  // PERSONA.md: stock-of-day = higher heat. Wry observation, not press
  // release. Rotate opener by day-of-year so the cron-fired version
  // doesn't read identically every day. Each opener is followed by the
  // company name on its own line and the URL — the persona's worked
  // example pattern.
  const isEtf = /\bETF\b/i.test(name) || /UNITS$/i.test(name);
  const isLow = (top.latestShortPosition ?? 0) < 10;

  const generalOpeners = [
    [
      `${code} at ${pct} shorted today.`,
      "",
      `Top of the ASIC table this morning. ${name}.`,
    ].join("\n"),

    [
      `${pct}.`,
      "",
      `That's the share of ${code} (${name}) sold short right now — currently the most-shorted name on the ASX by reported position.`,
    ].join("\n"),

    [
      `Today's #1 most-shorted: ${code} at ${pct}.`,
      "",
      `${name}.`,
    ].join("\n"),

    [
      `${code}. ${pct}.`,
      "",
      `The position keeps holding the top of the ASIC table.`,
      "",
      `${name}.`,
    ].join("\n"),
  ];

  const etfOpener = [
    `${code} (${name}) leads the short table at ${pct}.`,
    "",
    "Worth flagging that it's an ETF, not a single stock — and shorting a basket usually means a view on the underlying, not the wrapper itself.",
    "",
    "Either way, the borrow is out.",
  ].join("\n");

  const lowPctOpener = [
    `Today's most-shorted ASX name: ${code} at ${pct}.`,
    "",
    `Quiet day at the top of the table when ${pct} wins it. ${name}.`,
  ].join("\n");

  const doy = Math.floor(
    (Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86400000,
  );

  let body: string;
  // ETF angle wins on weekends to avoid spamming it every weekday.
  if (isEtf && doy % 3 === 0) {
    body = etfOpener;
  } else if (isLow) {
    body = lowPctOpener;
  } else {
    body = generalOpeners[doy % generalOpeners.length]!;
  }

  return [body, "", `${SITE}/shorts/${code}`].join("\n");
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
  const top = raw[0]!;
  const topPct = fmtPct(top.latestShortPosition ?? 0);

  // PERSONA.md: weekly-digest closer = higher heat (it's the kicker
  // tweet, the one most likely to be screenshotted). Vary the open of
  // each tweet by week number so consecutive Fridays don't read
  // identically. Drop the throat-clearing "ASX short selling —" intro.
  const intro = (() => {
    const intros = [
      `📊 Short-position wrap for week ${weekSlug}. ${top.productCode} sat at the top all week (${topPct}).`,
      `📊 Week ${weekSlug} of the ASIC short table is in the books. ${top.productCode} held the #1 spot at ${topPct}.`,
      `📊 Five trading days, four lots of T+4 data. Week ${weekSlug} — ${top.productCode} held ${topPct} of the table.`,
      `📊 ${weekSlug}. ${top.productCode} stayed top of the short table all week at ${topPct}. Quick wrap below.`,
    ];
    return intros[weekNo % intros.length]!;
  })();

  const middle = `🔴 Top 3 shorted ASX stocks this week:\n\n${topThree}`;
  const tail = `👀 Other names worth watching the next print on:\n\n${nextFour}`;
  const closer = `Full weekly breakdown — narrative, sector heatmap, days-to-cover — ${SITE}/reports/weekly/${weekSlug}`;

  return [intro, middle, tail, closer];
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

  // Prefer linking to an internal Shorted Take if one exists for this
  // story — closes the share-back loop to shorted.com.au. Falls back to
  // the per-stock news roll-up if no Take matches the headline.
  const take = await findTakeForStockHeadline(latest.stockCode!, latest.headline);
  const linkUrl = take
    ? `${SITE}/news/${take.slug}`
    : `${SITE}/shorts/${latest.stockCode}/news`;
  const linkLabel = take ? "Shorted Take" : "Full coverage";

  // Twitter wraps URLs to 23 chars; trim headline to fit alongside.
  const stockLine = `$${latest.stockCode} ${emoji}`;
  const sourceLine = `— via ${latest.source}`;
  const linkLine = `${linkLabel}: ${linkUrl}`;
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

// ============================================================
// Take publish — tweet a freshly-published /news/[slug] Take
// ============================================================

export function buildTakeTweet(take: EditorialTake): string {
  const stockLine = take.stockCode ? `$${take.stockCode}` : "Shorted Take";
  const urlLine = `${SITE}/news/${take.slug}`;
  const lead = take.bodyMd
    .split(/\n\s*\n/)[0]!
    .replace(/[*_`#>]/g, "")
    .trim();
  // Reserve room for stockLine + 2 blank lines + url (URL counts as 23 on X).
  const overhead = stockLine.length + 23 + 6;
  const budget = 270 - overhead;
  const headline = take.headline.length <= budget
    ? take.headline
    : take.headline.slice(0, budget - 1) + "…";
  // Decide between headline-only and headline + lead snippet based on space.
  const remaining = 270 - overhead - headline.length - 2;
  const snippet = lead.length > 0 && remaining > 60
    ? (lead.length <= remaining
        ? lead
        : lead.slice(0, remaining - 1) + "…")
    : null;
  const parts = [stockLine, "", headline];
  if (snippet) {
    parts.push("", snippet);
  }
  parts.push("", urlLine);
  return parts.join("\n");
}
