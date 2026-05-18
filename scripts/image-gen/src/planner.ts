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

Visual brand rules (DO NOT VIOLATE):
- Dark backgrounds with orange (#FFA94D) accents
- Editorial illustration register — modern financial publication
- Photorealistic OR isometric / abstract data-visualisation
- NEVER: stock-photo handshakes, generic cityscapes, businessmen, money
  stacks, gold bars, bull/bear icons, rocket ships, dollar signs,
  thumbs up/down, text in image, photoreal human faces
- Australian context cues only when the topic is geographically specific

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

export async function planAssets(input: PlanInput): Promise<AssetPlan[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY not set");
  }
  const ai = new GoogleGenerativeAI(key);
  const model = ai.getGenerativeModel({
    model: "gemini-2.0-flash",
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
  const assets = parsed.assets ?? [];

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
