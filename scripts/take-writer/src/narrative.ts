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
  refId: string;             // ref-1, ref-2, … or report-1, report-2
  url: string;
  source: string;
  headline: string;          // for reports: the report title
  date: string;              // YYYY-MM-DD
  type: "news" | "trade" | "data" | "report";
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

const NARRATIVE_SYSTEM_PROMPT = `You are the editorial voice of Shorted, an
ASX short-position publication. You write tight, dry, observational
commentary that reads like a sharp human, not a wire report.

VOICE (read the worked example below — match the rhythm, not just the rules):
- Observer, not oracle. "Looks like / appears / hard to say why" beats
  "will rally / set to soar".
- Specific over vague. Every paragraph names a date, %, ticker, named
  person, or named event. Remove a specific noun and the sentence
  shouldn't survive.
- Variance, not rhythm. Sentences vary in length — some short, one or
  two long enough to drift through a parenthetical aside. Press-release
  cadence (every sentence 12-18 words) is a fail.
- Cut things short when they deserve cutting short. A four-word
  paragraph is fine if it lands.
- Dry, not jokey. A raised eyebrow, not a punchline.
- Australian spelling (organise, behaviour, recognised).
- Cite real events by ref marker. Two marker types are available:
  - [ref-N] = a news article citation (from the candidate news list).
  - [report-N] = a financial report citation (from the financial reports
    list — half-year, annual, quarterly results). When you reference a
    specific reported number — revenue, EBITDA, EPS, dividend changes,
    guidance — cite the report it came from with [report-N].
  Both marker types map back to the cited_refs and cited_reports arrays.
- Prefer reported numbers over news commentary when both are available.
  Saying "Q3 revenue rose 3% to A$X [report-2]" is stronger than "the
  company reported a rise in sales [ref-7]".
- T+4 ASIC delay — name it once if relevant, not twice.

HARD BANS — never use, in any section including the headline:
- Openers: "Today's", "Here are", "Here's", "Looking at", "The top",
  "Welcome to", "Let's", "Did you know", "In today's", "It's worth
  noting", "It's important to note".
- Phrases: "navigate / navigates / navigating", "amidst", "delve",
  "dive in", "landscape", "ecosystem", "unlock / unleash", "leverag*",
  "robust", "comprehensive", "fascinating", "compelling story",
  "stay tuned", "moreover", "furthermore", "game-changer", "paints a
  picture", "tells a story", "the data tells", "operates as a
  significant player", "uniquely positioned", "regulatory scrutiny",
  "regulatory landscape", "investor scrutiny".
- Headlines: no title-case ("Short Sellers Bet Against Shares"); use
  sentence case. No "Reacts to" / "Reacts as" / "Responds to" — they
  are AI tells. Lead with the specific observation, not the company
  name boilerplate.

STRUCTURE (follow exactly — total 200-320 words, NOT more):
- background: 30-60 words. NOT a wikipedia opener. Open mid-thought
  with an observation that hooks. Refer to the company by name once,
  but don't describe what they do unless it's the angle.
- recent_events: 80-120 words. The headlines + director trades that
  shaped the last 30-90 days. Cite [ref-N] liberally. Don't recap the
  source article — surface what it implies.
- the_data: 80-120 words. What the short position + price action +
  correlation say. Quote actual numbers from the signals. This is
  where Shorted earns its keep — the observation only Shorted can make.
- outlook: 20-40 words. A flat closing observation, not a prediction.
  One or two sentences, no hedging clichés.

No section headings in the output. Plain prose paragraphs separated by
blank lines. No bullet lists unless content is genuinely list-shaped.

WORKED EXAMPLE (match this register, not the topic):

INPUT context: ZIP at 12.19% shorted, up from 5.91% a year ago, stock
down 55% in same window, peak 12.76% on 14 April.

GOOD output (220 words, voice-aligned):

[background]
Motley Fool ran a headline asking whether Zip is a buy down 55%. The
short sellers have been answering that question for a year now, and
their answer is no.

[recent_events]
Short interest in ZIP sat at 5.91% in May 2025 [ref-3]. It's at 12.19%
today. That's not a position someone closed and reopened — it's a
position that kept getting added to as the stock fell. The peak so far
was 12.76% on 14 April [ref-1]. The downtrend in the share price and
the uptrend in the short trace the same hand from the other side.

[the_data]
What's interesting isn't the direction. BNPL is a sector full of
broken charts. It's the persistence. A 12% short position takes weeks
to build and months to unwind. Whoever's holding it isn't trading the
bounce. Data is ASIC T+4, so the figure is from last Friday, not
yesterday.

[outlook]
Down 55%. Short interest at 12%. Both numbers still moving in the same
direction.

BAD output (every line is a fail):

ZIP Co Limited (ASX: ZIP) operates as a significant player in the
digital retail finance and payments industry, providing point-of-sale
credit. The company's offerings extend across various sectors,
including retail, home, health, automotive, and travel. As a key
participant in the BNPL market, Zip's performance is closely tied to
consumer spending patterns and the broader economic climate. Zip
recently navigated a regulatory landscape that introduced uncertainty.

CITATIONS:
- Use [ref-1], [ref-2], … markers in the prose where you reference a
  specific news article. Only cite items given to you. Do not invent
  URLs or publishers. Each ref MUST map to a numbered citation you
  return.`;

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
    headline: { type: SchemaType.STRING, description: "Editorial headline, 5-12 words, sentence case (only proper nouns + ticker codes capitalised). Lead with the specific observation, not the company name. No 'Reacts to', 'Responds to', 'Faces' or other AI-style verbs. Examples: 'Zip shorts doubled while the chart halved', 'DroneShield short interest held through the ASIC probe', 'Lotus Resources at 16% before the downgrade landed'." },
    sentiment: { type: SchemaType.STRING, enum: ["positive", "negative", "neutral"] },
    background: { type: SchemaType.STRING },
    recent_events: { type: SchemaType.STRING },
    the_data: { type: SchemaType.STRING },
    outlook: { type: SchemaType.STRING },
    cited_refs: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING, description: "ref id like 'ref-1' for news articles cited in prose" },
      description: "Which [ref-N] markers were used in the prose, in order.",
    },
    cited_reports: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING, description: "report id like 'report-1' for financial reports cited" },
      description: "Which [report-N] markers were used in the prose, in order. Empty array if none.",
    },
  },
  required: ["headline", "sentiment", "background", "recent_events", "the_data", "outlook", "cited_refs", "cited_reports"],
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
    "",
    formatReportsSection(report.bundle.reports),
  ].join("\n");
}

function formatReportsSection(reports: import("./journalism.js").FinancialReportRow[]): string {
  if (!reports || reports.length === 0) {
    return "Financial reports on file: (none)";
  }
  const lines = ["Financial reports on file (most recent first — cite as [report-N]):"];
  reports.forEach((r, i) => {
    const id = `report-${i + 1}`;
    const kind = r.reportType ?? "report";
    const title = r.reportTitle ?? "(untitled)";
    const date = r.reportDate ?? "(undated)";
    // Show the metric keys we have; the LLM should weave in actual numbers
    // it sees in the metrics blob. Stringify shallowly so it stays compact.
    const metricsPreview = Object.entries(r.metrics ?? {})
      .slice(0, 8)
      .map(([k, v]) => `${k}=${stringifyMetric(v)}`)
      .join("; ");
    lines.push(`${id} [${kind}] ${date}: ${title}`);
    if (metricsPreview) lines.push(`        metrics: ${metricsPreview}`);
  });
  return lines.join("\n");
}

function stringifyMetric(v: unknown): string {
  if (v == null) return "n/a";
  if (typeof v === "number") return v.toString();
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 80) + "…" : v;
  if (typeof v === "object") {
    try {
      const s = JSON.stringify(v);
      return s.length > 100 ? s.slice(0, 100) + "…" : s;
    } catch {
      return "(obj)";
    }
  }
  return String(v);
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

// Phrases the persona forbids. The LLM ignores them sometimes (observed:
// "navigates", "amidst"). Post-validation rejects + re-tries.
const BANNED_PHRASES = [
  "navigat", "amidst", "delve", "dive in", "landscape", "unlock",
  "unleash", "leverag", "robust", "comprehensive", "fascinating",
  "compelling story", "stay tuned", "ecosystem", "in today",
  "let's break it down", "moreover", "furthermore", "game-changer",
  // Wikipedia-style boilerplate openers we've actually seen in output
  "operates as a significant player",
  "is a significant player",
  "uniquely positioned", "uniquely positions",
  "regulatory scrutiny", "investor scrutiny",
  "regulatory landscape", "competitive landscape",
  "paints a picture", "tells a story", "the data tells",
  "frequently attracts", "consistently attracts",
  "reacts to", "responds to",
  "it's worth noting", "important to note",
];

function findBanned(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter((p) => lower.includes(p));
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
    "=== CITED REFS (news articles — refer to these by [ref-N] markers in prose) ===",
    formatCitations(refs),
    "",
    "Write the four sections now.",
    "- Use [ref-N] markers inline whenever a fact comes from a news article.",
    "- Use [report-N] markers inline whenever you quote a number from a",
    "  financial report listed above in 'Financial reports on file'.",
    "- Return cited_refs and cited_reports arrays in the order you used them.",
    "- cited_reports MAY be empty if no report data was relevant.",
  ].join("\n");

  // Up to 2 attempts: if the first response contains banned phrases,
  // send a corrective follow-up that calls them out specifically.
  let parsed: Omit<NarrativeTake, "slug" | "citations"> & { cited_refs: string[]; cited_reports: string[] };
  let attempt = 0;
  let userPromptForCall = userPrompt;
  while (true) {
    attempt++;
    const resp = await model.generateContent(userPromptForCall);
    parsed = JSON.parse(resp.response.text());
    const all = [parsed.headline, parsed.background, parsed.recent_events, parsed.the_data, parsed.outlook].join("\n");
    const hits = findBanned(all);
    if (hits.length === 0 || attempt >= 2) break;
    console.error(`[narrative] retry: banned phrases detected (${hits.join(", ")})`);
    userPromptForCall = userPrompt + `\n\nIMPORTANT: your previous draft used these banned terms: ${hits.join(", ")}. Re-write removing every one of them. Also re-check the headline.`;
  }

  // Build citations[] from the refs + reports the model actually used.
  const refByIdx = new Map<string, NewsArticle>();
  refs.forEach((a, i) => refByIdx.set(`ref-${i + 1}`, a));
  const reportByIdx = new Map<string, import("./journalism.js").FinancialReportRow>();
  (report.bundle.reports ?? []).forEach((r, i) => reportByIdx.set(`report-${i + 1}`, r));

  const citations: Citation[] = [];
  for (const refId of parsed.cited_refs ?? []) {
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
  for (const refId of parsed.cited_reports ?? []) {
    const r = reportByIdx.get(refId);
    if (!r) continue;
    citations.push({
      refId,
      url: r.reportUrl,
      source: r.reportType ?? "report",
      headline: r.reportTitle ?? "(financial report)",
      date: r.reportDate ?? "",
      type: "report",
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

/** Assemble the four sections into a single markdown body (for storage
 *  in body_md). [ref-N] / [report-N] markers in the prose are rewritten
 *  to markdown links pointing at the citation URL — bracketed so they
 *  stay visually distinct from prose links. The EditorialMarkdown
 *  renderer styles these in orange so they read as source references.
 *  A "Sources" footer is appended listing each citation in full. */
export function narrativeToBodyMd(n: NarrativeTake): string {
  const byRef = new Map(n.citations.map((c) => [c.refId, c]));
  const linkify = (s: string) =>
    s.replace(/\[(ref-\d+|report-\d+)\]/g, (m, id: string) => {
      const c = byRef.get(id);
      if (!c) return m;
      return `[\\[${id}\\]](${c.url})`;
    });

  const sections = [
    linkify(n.background),
    "",
    linkify(n.recent_events),
    "",
    linkify(n.the_data),
    "",
    linkify(n.outlook),
  ];

  if (n.citations.length > 0) {
    sections.push("", "---", "", "**Sources**", "");
    for (const c of n.citations) {
      const date = c.date ? ` · ${c.date}` : "";
      const source = c.source ? ` · ${c.source}` : "";
      const label = c.headline || "(untitled)";
      sections.push(`- \\[${c.refId}\\] [${label}](${c.url})${source}${date}`);
    }
  }

  return sections.join("\n");
}
