// Gemini-based asset planner.
//
// Given a Shorted Take article body (markdown), return a structured list
// of image assets the article needs. The pipeline command uses this to
// drive generate calls.
//
// Cost: Gemini 2.0 Flash is ~$0.0001 per Take — negligible.

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

export type AssetType = "hero" | "thumbnail" | "inline";

export interface AssetPlan {
  type: AssetType;
  topic: string;
  rationale: string;
}

const SYSTEM_PROMPT = `You are the visual editor for "Shorted", a financial
publication covering Australian stock market short positions. You decide
what images an editorial article needs.

Visual brand rules (HARD BANS — your topic descriptions will be
post-validated and rejected if they include any of these terms):

NEVER write topics containing or implying:
- Cityscapes, skylines, named cities (London, Tokyo, Sydney, etc.)
- Arrows, trend lines, upward lines, downward lines, charts crossing
- Pie charts, bar charts, line graphs, candlestick patterns
- Stock-photo finance: handshakes, businessmen, suited figures,
  trading floors, traders, screens with numbers, money stacks, gold
  bars, coins, banknotes
- Icons or symbols: bulls, bears, rockets, dollar signs, percent
  signs, thumbs up/down, target arrows
- Faces, people, figures (silhouettes are also banned)
- Any text, words, letters, or numbers in the image
- Australian flag, Aboriginal flag, opera house, harbour bridge,
  kangaroos, koalas

PREFER (every topic should pull from this list):
- Physical materials close-ups: raw ore, processed metal, paper
  documents on desks, ink on paper, industrial pipes, conveyor belts,
  storage tanks, shipping containers, mining equipment from
  unconventional angles
- Architectural: warehouse interiors, empty corridors, factory floors
  at low light, document archives, sorting facilities
- Natural: pit mines from above, salt flats, dry lake beds, mineral
  outcrops, dust in low light
- Abstract: paper textures, fabric folds, ceramic surfaces, metallic
  oxidation, single objects in negative space

Lighting/colour: low-key, deep shadow, single warm light source
(orange/amber) hitting a small portion of the frame. Editorial photo
register, not infographic.

For each article, output a small, focused asset plan:
- Always exactly ONE "hero" asset: 16:9 banner, the article's main image
- Optionally ONE "thumbnail": square, used for cards / link previews —
  include only if the article has a distinct secondary subject worth its
  own image (most articles do not need one)
- Optionally 0-2 "inline" assets: only if the article has clearly
  delineated sections that would benefit from breaking up the wall of
  text. Most ≤300-word Takes need 0 inline images.

For each asset's "topic", write a vivid, specific image brief in 1-2
sentences. Reference concrete subjects (an open-pit mine, a steel
conveyor belt, a single document on a desk, a shipping container yard at
dusk). Do NOT include brand rules in the topic — those are appended
separately. Do NOT include text-in-image instructions.

For "rationale", write one short sentence on why this asset.

Be parsimonious. 1-2 assets per article is usually right. Articles
shorter than 200 words almost never need more than a hero.`;

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    assets: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          type: { type: SchemaType.STRING, enum: ["hero", "thumbnail", "inline"] },
          topic: { type: SchemaType.STRING },
          rationale: { type: SchemaType.STRING },
        },
        required: ["type", "topic", "rationale"],
      },
    },
  },
  required: ["assets"],
};

export interface PlanInput {
  headline: string;
  bodyMd: string;
  stockCode?: string;
  sentiment?: string;
}

// Words/phrases that almost always indicate a brand violation in the
// topic string. Matched case-insensitively; if a topic contains any of
// these, the planner discards it and falls back to a safe default. This
// is the last line of defence — Gemini sometimes ignores the system
// prompt's bans (observed: "Tokyo skyline at night", "upward-trending
// arrow").
const BANNED_TOPIC_TERMS = [
  "skyline",
  "cityscape",
  "city",
  "tokyo",
  "london",
  "sydney",
  "new york",
  "manhattan",
  "arrow",
  "trending line",
  "trend line",
  "upward",
  "downward",
  "chart",
  "graph",
  "candlestick",
  "pie chart",
  "bar chart",
  "businessman",
  "businesswoman",
  "trader",
  "trading floor",
  "handshake",
  "rocket",
  "bull market",
  "bear market",
  "dollar sign",
  "thumbs up",
  "thumbs down",
  "money stack",
  "gold bar",
  "opera house",
  "harbour bridge",
  "kangaroo",
  "koala",
];

function scrubTopic(asset: AssetPlan): AssetPlan {
  const lower = asset.topic.toLowerCase();
  const hits = BANNED_TOPIC_TERMS.filter((t) => lower.includes(t));
  if (hits.length === 0) return asset;
  console.warn(
    `[planner] topic contained banned terms (${hits.join(", ")}); replacing with safe fallback`,
  );
  return {
    type: asset.type,
    topic:
      "Editorial close-up photograph: a single physical object related to the article subject (industrial material, document, raw resource) on a dark surface with deep shadow and a single warm amber light source catching one edge.",
    rationale: `Original topic rejected for banned terms: ${hits.join(", ")}. ${asset.rationale}`,
  };
}

export async function planAssets(input: PlanInput): Promise<AssetPlan[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY not set");
  }
  const ai = new GoogleGenerativeAI(key);
  const model = ai.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.4,
    },
  });

  const userPrompt = [
    `Article headline: ${input.headline}`,
    input.stockCode ? `Stock code: ${input.stockCode}` : "",
    input.sentiment ? `Sentiment: ${input.sentiment}` : "",
    "",
    "Article body (markdown):",
    input.bodyMd,
  ]
    .filter(Boolean)
    .join("\n");

  const resp = await model.generateContent(userPrompt);
  const text = resp.response.text();
  const parsed = JSON.parse(text) as { assets: AssetPlan[] };
  const assets = (parsed.assets ?? []).map(scrubTopic);

  // Enforce invariants the schema can't:
  // - At most 1 hero. If model returns multiple, keep the first.
  // - At most 1 thumbnail.
  // - At most 2 inline.
  const out: AssetPlan[] = [];
  let heroCount = 0;
  let thumbCount = 0;
  let inlineCount = 0;
  for (const a of assets) {
    if (a.type === "hero" && heroCount < 1) {
      out.push(a);
      heroCount++;
    } else if (a.type === "thumbnail" && thumbCount < 1) {
      out.push(a);
      thumbCount++;
    } else if (a.type === "inline" && inlineCount < 2) {
      out.push(a);
      inlineCount++;
    }
  }
  // If model omitted hero, synthesise a generic one from the headline.
  if (heroCount === 0) {
    out.unshift({
      type: "hero",
      topic: `Editorial banner illustrating: ${input.headline}`,
      rationale: "Default hero — model did not propose one",
    });
  }
  return out;
}
