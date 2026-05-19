// Editorial agenda — what's actually worth writing about right now.
//
// A real journalist doesn't pick a stock arbitrarily. They scan signals
// across the universe and pick the ones with a story attached:
//   - Regulatory triggers (ASIC probe, lawsuit, settlement)
//   - Leadership changes (CEO out, board reshuffle)
//   - Earnings events (results, revenue beats/misses)
//   - Capitulation: rising shorts + falling price + negative news
//   - Squeeze setup: rising shorts + rising price
//   - Director signal: insider buy/sell concentration
//   - Peer divergence: this stock's short well outside sector norm
//   - Fresh data: 7-day short slope sharp
//
// For each top-shorted candidate, run the journalism bundle, classify
// the dominant angle, score it, and return a ranked agenda.

import { Client as PgClient } from "pg";
import { buildReport, type JournalismReport } from "./journalism.js";

export type AgendaAngle =
  | "regulatory_trigger"
  | "leadership_change"
  | "earnings_event"
  | "capitulation"
  | "squeeze_setup"
  | "director_signal"
  | "peer_divergence"
  | "fresh_data_spike"
  | "news_explosion"
  | "quiet_position"
  | "general";

export interface AgendaCandidate {
  stockCode: string;
  name: string;
  industry: string | null;
  score: number;
  angle: AgendaAngle;
  rationale: string;
  triggeredSignals: string[];
  keyEvents: Array<{ date: string; source: string; headline: string; url: string }>;
  report: JournalismReport;
}

// Keyword patterns for each angle.
const REGULATORY_KEYWORDS = /\b(asic|investigation|probe|lawsuit|settle|fine|class action|regulator|court|ruling|allegation|breach|infringe)\b/i;
const LEADERSHIP_KEYWORDS = /\b(ceo|chief executive|chairman|cfo|chief financial officer|steps down|departs|resign|appoint|new (?:ceo|chairman|cfo))\b/i;
const EARNINGS_KEYWORDS = /\b(earnings|q[1-4]|quarterly|revenue|results|interim|full[-\s]year|guidance|profit|loss|ebitda)\b/i;

function classifyByKeywords(
  text: string,
): { regulatory: boolean; leadership: boolean; earnings: boolean } {
  return {
    regulatory: REGULATORY_KEYWORDS.test(text),
    leadership: LEADERSHIP_KEYWORDS.test(text),
    earnings: EARNINGS_KEYWORDS.test(text),
  };
}

interface ScoringResult {
  score: number;
  triggered: string[];
  angle: AgendaAngle;
  rationale: string[];
  keyEvents: AgendaCandidate["keyEvents"];
}

function scoreCandidate(report: JournalismReport): ScoringResult {
  const s = report.signals;
  const triggered: string[] = [];
  const rationale: string[] = [];
  const candidateAngles: AgendaAngle[] = [];
  let score = 0;

  // --- 1. Hard-news triggers from headlines (high weight) ---
  let regulatory = false;
  let leadership = false;
  let earnings = false;
  const recentNews = report.bundle.news.slice(0, 30);
  for (const a of recentNews) {
    const k = classifyByKeywords(`${a.headline} ${a.summary ?? ""}`);
    if (k.regulatory) regulatory = true;
    if (k.leadership) leadership = true;
    if (k.earnings) earnings = true;
  }
  if (regulatory) {
    score += 30;
    triggered.push("regulatory");
    candidateAngles.push("regulatory_trigger");
    rationale.push("recent news contains regulatory/investigation keywords");
  }
  if (leadership) {
    score += 20;
    triggered.push("leadership_change");
    candidateAngles.push("leadership_change");
    rationale.push("recent news contains leadership-change keywords");
  }
  if (earnings) {
    score += 15;
    triggered.push("earnings_event");
    candidateAngles.push("earnings_event");
    rationale.push("recent news contains earnings/results keywords");
  }

  // --- 2. Capitulation / Squeeze pattern (medium weight) ---
  const shortRising =
    s.shortPctChange90d !== null && s.shortPctChange90d > 0.5;
  const priceDownSharp = s.priceChange1m !== null && s.priceChange1m < -8;
  const priceUpSharp = s.priceChange1m !== null && s.priceChange1m > 8;
  if (shortRising && priceDownSharp) {
    score += 18;
    triggered.push("capitulation");
    candidateAngles.push("capitulation");
    rationale.push(`shorts +${s.shortPctChange90d!.toFixed(2)}% vs 90d avg, price ${s.priceChange1m!.toFixed(1)}% in 30d`);
  } else if (shortRising && priceUpSharp) {
    score += 14;
    triggered.push("squeeze_setup");
    candidateAngles.push("squeeze_setup");
    rationale.push(`shorts +${s.shortPctChange90d!.toFixed(2)}% vs 90d avg WHILE price up ${s.priceChange1m!.toFixed(1)}% in 30d`);
  }

  // --- 3. Strong price-shorts correlation (signals an active dynamic) ---
  if (s.priceShortsCorrelation30d !== null && Math.abs(s.priceShortsCorrelation30d) > 0.7) {
    score += 8;
    triggered.push("strong_correlation");
    rationale.push(`30d price-shorts corr ${s.priceShortsCorrelation30d.toFixed(2)} — active dynamic`);
  }

  // --- 4. Director trade signal (medium weight) ---
  if (s.directorTradesLast90d > 0 && Math.abs(s.directorNetValueLast90d) > 100_000) {
    score += 10;
    triggered.push("director_signal");
    candidateAngles.push("director_signal");
    const direction = s.directorNetValueLast90d > 0 ? "net buy" : "net sell";
    rationale.push(`director ${direction} ~$${Math.abs(s.directorNetValueLast90d / 1000).toFixed(0)}k in 90d`);
  }

  // --- 5. Fresh 7d short slope spike ---
  if (s.shortSlope7d !== null && Math.abs(s.shortSlope7d) > 0.15) {
    score += 8;
    triggered.push("fresh_data_spike");
    candidateAngles.push("fresh_data_spike");
    const dir = s.shortSlope7d > 0 ? "+" : "";
    rationale.push(`7d short slope ${dir}${s.shortSlope7d.toFixed(2)}%/day — fast-moving position`);
  }

  // --- 6. Peer divergence ---
  if (
    s.peerSectorAverageShort !== null &&
    s.currentShortPct !== null &&
    s.currentShortPct - s.peerSectorAverageShort > 5
  ) {
    score += 7;
    triggered.push("peer_divergence");
    candidateAngles.push("peer_divergence");
    rationale.push(`${s.currentShortPct.toFixed(2)}% vs sector avg ${s.peerSectorAverageShort.toFixed(2)}%`);
  }

  // --- 7. News density spike ---
  if (s.newsArticlesLast7d > 10) {
    score += 6;
    triggered.push("news_explosion");
    candidateAngles.push("news_explosion");
    rationale.push(`${s.newsArticlesLast7d} articles in last 7d — heavy coverage`);
  }

  // --- 8. Quiet but heavily shorted ---
  if (
    s.currentShortPct !== null && s.currentShortPct > 8 &&
    s.newsArticlesLast30d < 5
  ) {
    score += 5;
    triggered.push("quiet_position");
    candidateAngles.push("quiet_position");
    rationale.push(`${s.currentShortPct.toFixed(2)}% short with only ${s.newsArticlesLast30d} articles in 30d`);
  }

  // --- 9. Sentiment trend ---
  if (s.sentimentTrendLast30d === "deteriorating") {
    score += 4;
    triggered.push("sentiment_deteriorating");
    rationale.push("sentiment trend deteriorating");
  } else if (s.sentimentTrendLast30d === "improving") {
    score += 3;
    triggered.push("sentiment_improving");
    rationale.push("sentiment trend improving");
  }

  // --- 10. Sheer size of position ---
  if (s.currentShortPct !== null) {
    if (s.currentShortPct > 15) score += 6;
    else if (s.currentShortPct > 10) score += 3;
  }

  // Pick the most newsworthy angle from the candidates. Hard-news beats
  // pattern beats anomaly beats density.
  const angleOrder: AgendaAngle[] = [
    "regulatory_trigger",
    "leadership_change",
    "earnings_event",
    "capitulation",
    "squeeze_setup",
    "director_signal",
    "fresh_data_spike",
    "peer_divergence",
    "news_explosion",
    "quiet_position",
  ];
  let angle: AgendaAngle = "general";
  for (const a of angleOrder) {
    if (candidateAngles.includes(a)) {
      angle = a;
      break;
    }
  }

  const keyEvents = report.bundle.news
    .filter((a) => a.isPriceSensitive || (a.sentiment && a.sentiment !== "neutral"))
    .slice(0, 5)
    .map((a) => ({
      date: a.publishedAt.slice(0, 10),
      source: a.source,
      headline: a.headline,
      url: a.url,
    }));

  return { score, triggered, angle, rationale, keyEvents };
}

const ETF_PATTERNS = [
  /\bETF\b/i, /\bUNITS$/i, /\bINDEX FUND\b/i, /\bMANAGED FUND\b/i,
];

function isEditorialEligible(name: string | null): boolean {
  if (!name) return false;
  return !ETF_PATTERNS.some((rx) => rx.test(name));
}

export interface AgendaOptions {
  poolSize: number;        // how many top-shorted to consider
  topN: number;            // how many to surface
  minScore: number;        // floor on score
  enforceSectorDiversity: boolean;
}

export async function buildAgenda(
  pg: PgClient,
  opts: Partial<AgendaOptions> = {},
): Promise<AgendaCandidate[]> {
  const cfg: AgendaOptions = {
    poolSize: opts.poolSize ?? 30,
    topN: opts.topN ?? 5,
    minScore: opts.minScore ?? 25,
    enforceSectorDiversity: opts.enforceSectorDiversity ?? true,
  };

  // Pull pool ranked by short %.
  const { rows } = await pg.query<{ product_code: string; current_percent: number }>(
    `SELECT product_code, current_percent FROM mv_top_shorts
     ORDER BY current_percent DESC LIMIT $1`,
    [cfg.poolSize],
  );
  const codes = rows.map((r) => r.product_code);
  console.error(`[agenda] pool: ${codes.length} candidates`);

  // Sequential to keep DB load low (each buildReport runs ~5 queries).
  const candidates: AgendaCandidate[] = [];
  for (const code of codes) {
    try {
      const report = await buildReport(pg, code);
      const name = report.bundle.meta.name ?? "";
      if (!isEditorialEligible(name)) {
        console.error(`  skip ${code}: ${name} looks like an ETF`);
        continue;
      }
      const score = scoreCandidate(report);
      if (score.score < cfg.minScore) {
        console.error(`  skip ${code}: score ${score.score} < ${cfg.minScore}`);
        continue;
      }
      candidates.push({
        stockCode: code,
        name,
        industry: report.bundle.meta.industry,
        score: score.score,
        angle: score.angle,
        rationale: score.rationale.join(" · "),
        triggeredSignals: score.triggered,
        keyEvents: score.keyEvents,
        report,
      });
      console.error(`  ✓ ${code}: score ${score.score} — ${score.angle}`);
    } catch (err) {
      console.error(`  ! ${code}: ${String(err).slice(0, 80)}`);
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // Sector diversity: at most 2 per industry in the top-N.
  if (cfg.enforceSectorDiversity) {
    const byIndustry = new Map<string, number>();
    const out: AgendaCandidate[] = [];
    for (const c of candidates) {
      const ind = c.industry ?? "_unknown";
      const seen = byIndustry.get(ind) ?? 0;
      if (seen >= 2) continue;
      byIndustry.set(ind, seen + 1);
      out.push(c);
      if (out.length >= cfg.topN) break;
    }
    return out;
  }
  return candidates.slice(0, cfg.topN);
}

export function formatAgendaCandidate(c: AgendaCandidate, idx: number): string {
  const lines = [
    `${idx + 1}. ${c.stockCode}  score=${c.score}  angle=${c.angle}`,
    `   ${c.name} (${c.industry ?? "—"})`,
    `   ${c.rationale}`,
  ];
  if (c.keyEvents.length > 0) {
    lines.push(`   latest event: [${c.keyEvents[0]!.source}] ${c.keyEvents[0]!.headline.slice(0, 90)}`);
  }
  return lines.join("\n");
}
