// Gemini-based asset planner.
//
// Given a Shorted Take article body (markdown), return a structured list
// of image assets the article needs. The pipeline command uses this to
// drive generate calls.
//
// Cost: Gemini 2.0 Flash is ~$0.0001 per Take — negligible.

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { scrubTopic } from "./topic-policy.js";
import { EDITORIAL_CRAFT_RULES } from "./brand-prompt.js";

export type AssetType = "hero" | "thumbnail" | "inline";

export interface AssetPlan {
  type: AssetType;
  topic: string;
  rationale: string;
}

const SYSTEM_PROMPT = `You are the visual editor for Shorted, an Australian
research publication covering markets, housing and public records. Plan
article-specific conceptual editorial illustrations.

Every brief needs one concrete subject and one visual action tied to the
article's finding or mechanism. Preserve uncertainty and disputed claims.
Prefer tactile cut-paper collage, printmaking, sculptural material still life
or a relevant material close-up. Use warm paper, charcoal and selective amber;
let each subject add restrained sage, rust, oil blue or brick. Choose light or
dark according to the story, rather than repeating a dark scene and rim light.
Relevant Australian housing forms and industrial subjects are welcome.

${EDITORIAL_CRAFT_RULES}

Do not request baked-in text, numbers, logos, measured charts, invented product
UI, human faces, generic finance icons, handshakes, money piles, bull/bear
mascots, rockets, glowing fintech wallpaper or isometric asset-pack scenes.
Generated art is an illustration, never a claimed photograph of a real event,
site or person. Keep precise data in accessible project-owned MDX figures.

For each article, output a small focused plan:
- Exactly ONE hero, wide 16:9 with a strong silhouette readable at 160 x 90.
- Optionally ONE thumbnail only when a distinct secondary subject needs it;
  it also uses wide 16:9, not a different square visual identity.
- Optionally 0-2 inline assets only when a section benefits from illustration.
  Most short Takes need just one hero.

Write each topic as a vivid subject-and-action brief in 1-2 sentences,
not the SEO title alone. Include the relevant caveat so the visual does not
make a stronger claim than the article. Brand rules are appended separately.
For rationale, give one short sentence explaining the illustration's purpose.`;

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
  const assets = (parsed.assets ?? []).map((asset) => scrubTopic(asset, input.headline));

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
