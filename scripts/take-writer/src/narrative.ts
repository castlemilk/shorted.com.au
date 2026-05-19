// Journalism engine — chunk B: Gemini multi-section synthesis.
//
// Takes the JournalismReport (bundle + signals) and produces a
// structured Shorted Take with:
//   - background        — what the company is, where it sits in the sector
//   - recent_events     — the news/announcement chain that shaped this
//                          period, cited with [ref-N] markers
//   - the_data          — what the short position + price action say
//                          (also cite specific dates / events)
//   - outlook           — flat observation, NOT prediction
//   - citations[]       — array of { id, url, source, headline, date }
//                          referenced by ref-N markers in the body
//   - slug              — kebab-case URL fragment
//   - sentiment         — derived from the synthesis

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { type JournalismReport, type NewsArticle } from "./journalism.js";

export interface Citation {
  refId: string;             // ref-1, ref-2, …
  url: string;
  source: string;
  headline: string;
  date: string;              // YYYY-MM-DD
  type: "news" | "trade" | "data";
}

export interface NarrativeTake {
  slug: string;
  headline: string;
  sentiment: "positive" | "negative" | "neutral";
  background: string;
  recent_events: string;
  the_data: string;
  outlook: string;
  citations: Citation[];
}

const NARRATIVE_SYSTEM_PROMPT = `You are the senior editor of Shorted, an
ASX short-position publication. You write data-driven, dry, observational
editorials.

VOICE (sticks for the whole article):
- Observer, not oracle. "Looks like / appears to / hard to say why" beats
  "will rally / set to soar".
- Specific. Every paragraph names a date, %, ticker, named person or
  named event. If you can remove a specific noun, the sentence wasn't
  saying anything.
- Variance: mix short and long sentences. The reader should hear rhythm
  changes.
- Australian spelling. No filler ("dive in", "delve", "landscape",
  "navigate", "ecosystem", "robust", "comprehensive", "fascinating",
  "compelling story", "stay tuned").
- Cite real events by ref marker. Wherever you cite a fact that comes
  from a news article, write the inline marker [ref-N] right after the
  fact. N is the index in the cited_refs you return.
- Acknowledge the T+4 ASIC delay where relevant.

STRUCTURE (must follow exactly):
- background: 120-180 words. The company, sector, why it's interesting.
- recent_events: 180-260 words. The headlines and director trades that
  shaped the last 30-90 days. Cite ref markers liberally.
- the_data: 180-260 words. What the short position + price action +
  correlation say. Quote the actual numbers from the signals.
- outlook: 80-120 words. A flat closing observation, NOT a prediction.

Each section is plain prose paragraphs separated by blank lines. No
headings inside sections. No bullet lists unless content is genuinely
list-shaped.

CITATIONS:
- Use [ref-1], [ref-2], … markers in the prose where you reference a
  specific news article.
- Only cite items that were given to you. Do not invent URLs or
  publishers.
- Each ref MUST map to a numbered citation you return.`;

const SLUG_PROMPT = `Generate a short, kebab-case slug for this Take.
Rules:
- Lowercase, words separated by hyphens
- Start with the stock code lowercased (e.g. "dro-")
- 5-7 words total, max 80 chars
- Captures the journalistic angle, not just the headline

Output ONLY the slug, nothing else.

Headline: {{HEADLINE}}
Stock: {{STOCK_CODE}}`;

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    headline: { type: SchemaType.STRING, description: "Editorial headline, 6-14 words, no clickbait" },
    sentiment: { type: SchemaType.STRING, enum: ["positive", "negative", "neutral"] },
    background: { type: SchemaType.STRING },
    recent_events: { type: SchemaType.STRING },
    the_data: { type: SchemaType.STRING },
    outlook: { type: SchemaType.STRING },
    cited_refs: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING, description: "ref id like 'ref-1'" },
      description: "Which ref markers were used, in the order they were used in the prose.",
    },
  },
  required: ["headline", "sentiment", "background", "recent_events", "the_data", "outlook", "cited_refs"],
};

function buildCitationCandidates(report: JournalismReport): NewsArticle[] {
  // Rank: price-sensitive first, then recency, then sentiment-non-neutral.
  return [...report.bundle.news]
    .sort((a, b) => {
      if (a.isPriceSensitive !== b.isPriceSensitive) return a.isPriceSensitive ? -1 : 1;
      const sd = (a.sentiment && a.sentiment !== "neutral" ? 0 : 1) -
                 (b.sentiment && b.sentiment !== "neutral" ? 0 : 1);
      if (sd !== 0) return sd;
      return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    })
    .slice(0, 20);
}

function formatSignalsForPrompt(report: JournalismReport): string {
  const s = report.signals;
  const m = report.bundle.meta;
  const fmtNum = (n: number | null, decimals = 2, suffix = "") =>
    n == null ? "n/a" : `${n.toFixed(decimals)}${suffix}`;
  return [
    `Stock: ${m.stockCode} — ${m.name ?? "?"}`,
    `Industry: ${m.industry ?? "?"}`,
    `Description: ${m.description?.slice(0, 300) ?? "(none)"}`,
    "",
    `Current short %: ${fmtNum(s.currentShortPct, 2, "%")}`,
    `90d short avg: ${fmtNum(s.shortPct90dAvg, 2, "%")} (change ${fmtNum(s.shortPctChange90d, 2, "%")})`,
    `90d range: ${fmtNum(s.shortPctMinIn90d, 2)} – ${fmtNum(s.shortPctMaxIn90d, 2)}%`,
    `Short slope (rolling %/day): 90d=${fmtNum(s.shortSlope90d, 4)}, 30d=${fmtNum(s.shortSlope30d, 4)}, 7d=${fmtNum(s.shortSlope7d, 4)}`,
    "",
    `Current price: ${fmtNum(s.currentPrice, 2)} AUD`,
    `Price change: 1m=${fmtNum(s.priceChange1m, 1, "%")}, 3m=${fmtNum(s.priceChange3m, 1, "%")}, 6m=${fmtNum(s.priceChange6m, 1, "%")}, 12m=${fmtNum(s.priceChange12m, 1, "%")}`,
    `Price-short correlation (30d Pearson on daily Δ pairs): ${fmtNum(s.priceShortsCorrelation30d, 3)}`,
    "",
    `News density: ${s.newsArticlesLast30d} articles in 30d, ${s.newsArticlesLast7d} in 7d`,
    `Price-sensitive count (30d): ${s.priceSensitiveLast30d}`,
    `Sentiment mix (30d): +${s.sentimentMix.positive} −${s.sentimentMix.negative} =${s.sentimentMix.neutral}`,
    `Sentiment trend: ${s.sentimentTrendLast30d}`,
    "",
    `Director trades (90d): ${s.directorTradesLast90d} trades, net AUD ${fmtNum(s.directorNetValueLast90d, 0)} (buys − sells)`,
    `Most recent director trade: ${s.directorMostRecentDate ?? "(none)"}`,
    "",
    `Peer sector avg short %: ${fmtNum(s.peerSectorAverageShort, 2, "%")} — ${m.stockCode} is ${s.peerRelative}`,
    `Peers in same industry: ${report.bundle.peers.map((p) => `${p.code}(${p.currentPct.toFixed(2)}%)`).join(", ") || "(none)"}`,
  ].join("\n");
}

function formatCitations(refs: NewsArticle[]): string {
  return refs
    .map((a, i) => {
      const id = `ref-${i + 1}`;
      const date = a.publishedAt.slice(0, 10);
      const sentiment = a.sentiment ? ` [${a.sentiment}]` : "";
      const flag = a.isPriceSensitive ? " [PRICE-SENSITIVE]" : "";
      const summary = a.summary ? ` — ${a.summary.slice(0, 200)}` : "";
      return `${id} (${date}, ${a.source}${sentiment}${flag}): ${a.headline}${summary}`;
    })
    .join("\n");
}

export async function synthesiseNarrative(report: JournalismReport): Promise<NarrativeTake> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const refs = buildCitationCandidates(report);
  const ai = new GoogleGenerativeAI(apiKey);
  const model = ai.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: NARRATIVE_SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.7,
      maxOutputTokens: 8000,
    },
  });

  const userPrompt = [
    "=== SIGNALS ===",
    formatSignalsForPrompt(report),
    "",
    "=== CITED REFS (refer to these by ref-N markers in your prose) ===",
    formatCitations(refs),
    "",
    "Write the four sections now. Use [ref-N] markers inline whenever a",
    "fact comes from one of the cited refs. Return the cited_refs array",
    "in the order you used them.",
  ].join("\n");

  const resp = await model.generateContent(userPrompt);
  const parsed = JSON.parse(resp.response.text()) as Omit<NarrativeTake, "slug" | "citations">
    & { cited_refs: string[] };

  // Build citations[] from the refs the model actually used.
  const refByIdx = new Map<string, NewsArticle>();
  refs.forEach((a, i) => refByIdx.set(`ref-${i + 1}`, a));
  const citations: Citation[] = [];
  for (const refId of parsed.cited_refs) {
    const a = refByIdx.get(refId);
    if (!a) continue;
    citations.push({
      refId,
      url: a.url,
      source: a.source,
      headline: a.headline,
      date: a.publishedAt.slice(0, 10),
      type: "news",
    });
  }

  // Slug pass.
  const slugModel = ai.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
  });
  const slugResp = await slugModel.generateContent(
    SLUG_PROMPT.replace("{{HEADLINE}}", parsed.headline)
               .replace("{{STOCK_CODE}}", report.bundle.meta.stockCode),
  );
  const slug = slugResp.response.text().trim().toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "").replace(/\s+/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 80);

  return {
    slug,
    headline: parsed.headline,
    sentiment: parsed.sentiment,
    background: parsed.background,
    recent_events: parsed.recent_events,
    the_data: parsed.the_data,
    outlook: parsed.outlook,
    citations,
  };
}

/** Assemble the four sections into a single markdown body (for storage in body_md). */
export function narrativeToBodyMd(n: NarrativeTake): string {
  return [
    n.background,
    "",
    n.recent_events,
    "",
    n.the_data,
    "",
    n.outlook,
  ].join("\n");
}
