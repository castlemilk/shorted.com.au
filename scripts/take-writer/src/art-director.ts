import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import OpenAI from "openai";
import { Storage } from "@google-cloud/storage";
import { illustrationCaption } from "./illustration-caption.js";
import { EDITORIAL_CRAFT_RULES } from "./editorial-art-policy.js";

const GCS_BUCKET = process.env.GCS_LOGO_BUCKET ?? "shorted-company-logos";
const ART_MODEL = () => process.env.ART_DIRECTOR_MODEL ?? "gemini-3.5-flash";

export interface LayoutImage {
  url: string;
  style: string;
  ratio: "landscape" | "portrait" | "square";
  brief: string;
  caption: string;
  placement: "full" | "left" | "right" | "inset";
  anchorAfterBlock: number;
  /** "hero" = the page-top masthead image (exactly one per plan); "inline" = body layout image. */
  role: "hero" | "inline";
}

export type ImageQuality = "low" | "medium" | "high";

export interface ArtContext {
  stockCode: string;
  headline: string;
  industry: string | null;
  description: string | null;   // company-metadata.summary/description — often has location + project names
  bodyMd: string;
  dossierSummary?: string;
  keyFacts?: string[];          // e.g. dossier keyNumbers/threads flattened to strings
  reportMetrics?: string[];     // e.g. ["revenue=A$1.2bn", "net_profit=-A$40m"]
}

export const STYLE_PROMPTS: Record<string, string> = {
  paper_collage: "Conceptual editorial illustration in hand-cut paper collage. One recognisable subject performing one story-specific visual action, strong silhouette, tactile paper edges and warm ink. Selective amber with restrained subject colours such as sage, rust, oil black or limestone. Warm paper or dark ink ground chosen for the story; central crop-safe composition. NOT: baked-in text, numbers, logos, fake charts or interfaces, generic fintech symbols, toy-like asset packs, simulated news photography.",
  printmaking: "Conceptual editorial illustration using woodcut or screen-print texture, warm paper, substantial ink shapes and selective amber. One concrete subject and one meaningful action, clear negative space and a silhouette readable at thumbnail size. Light or dark composition according to the subject, restrained sage or rust where useful. NOT: text, numbers, logos, invented measured data, generic financial wallpaper, simulated news photography.",
  documentary: "Photographic material study presented as a conceptual editorial illustration. Natural light, tangible texture, restrained subject colours, warm paper or ink ground. Depict arranged objects or a visibly reconstructed model, never an image claiming to document an actual event, named site or facility. NOT: text, charts, logos, readable signage, people, watermarks, simulated wire photography, oversaturation, HDR halos.",
  aerial: "Conceptual editorial illustration of a landscape or architectural model viewed from a three-quarter aerial angle. Tactile surfaces, warm paper or dark ink setting, readable scale and a story-specific relationship between objects. Generic geographical context only; do not claim to show an actual named site or event. NOT: text, logos, map labels, people, fisheye distortion, simulated news photography.",
  still_life: "Conceptual editorial still life. A recognisable physical subject in one story-specific action or comparison, tactile material detail, soft natural or raking light, deliberate negative space. Warm paper, raw stone or dark ink surface selected for the subject, selective amber and restrained material colours. NOT: text, labels, logos, people, generic lifestyle props, fabricated documentary scenes, glossy fintech symbols.",
  isometric: "Conceptual sculptural editorial illustration, physical layered paper or material models viewed at an oblique angle, readable subject and meaningful action. Warm paper or dark ink ground, restrained sage/rust and selective amber, matte texture. NOT: text, numbers, axis labels, fabricated data, visible UI elements, glowing asset packs, glossy toy-like 3D.",
  archival: "Archival-inspired editorial illustration using grainy monochrome or restrained faded colour, period-appropriate material models, scanned-paper texture. Clearly an illustration, never a fabricated historical photograph, document, event or named location. NOT: text, logos, watermarks, people, simulated press photography.",
  abstract: "Conceptual editorial art built from recognisable folded-paper or material objects, showing one specific story mechanism through a clear visual action. Warm ink/paper, selective amber, restrained subject colours and generous negative space. NOT: text, charts, dollar signs, bulls or bears, logos, gradients as the subject, glossy chrome, generic financial wallpaper.",
  environmental: "Conceptual editorial illustration of an industrial or landscape context using paper, print texture or tangible models. One dominant subject and a story-specific action or tension, restrained natural material colours on warm paper or dark ink. Do not imitate a photograph of an actual event, named facility or location. NOT: text, signage, logos, people, dramatic HDR, lens flare, simulated photojournalism.",
};

const PLAN_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    images: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          role: { type: SchemaType.STRING, enum: ["hero", "inline"], format: "enum" },
          style: { type: SchemaType.STRING, enum: Object.keys(STYLE_PROMPTS), format: "enum" },
          ratio: { type: SchemaType.STRING, enum: ["landscape", "portrait", "square"], format: "enum" },
          brief: { type: SchemaType.STRING, description: "A conceptual illustration showing one concrete subject and one visual action tied to THIS article's finding or mechanism. Article details inform the subject, never a fabricated photograph of a real place, facility or event. No text, invented data, logos, readable labels or people." },
          caption: { type: SchemaType.STRING, description: "Short caption (<=12 words) beginning 'Illustration:' and describing the conceptual subject/action, without claiming a real photographed place or event." },
          placement: { type: SchemaType.STRING, enum: ["full", "left", "right", "inset"], format: "enum" },
          anchorAfterBlock: { type: SchemaType.NUMBER, description: "0-based index of the body block (blank-line-separated) AFTER which to place this image." },
        },
        required: ["role", "style", "ratio", "brief", "caption", "placement", "anchorAfterBlock"],
      },
    },
  },
  required: ["images"],
};

const ART_SYSTEM = `You are the art director for Shorted, the publication side of a warm Australian market terminal. Design a coherent editorial set of conceptual illustrations for one article. Rules:
- The FIRST image is the HERO: role='hero', ratio='landscape', default to paper_collage or still_life. Show one recognisable concrete subject performing one visual action that communicates THIS article's finding, mechanism or tension. It must work as a 16:9 masthead and at 160x90 thumbnail size; keep the subject and action in the central 80%. Every other image is role='inline'.
- Use tactile paper collage, printmaking or sculptural still life. Vary treatment and ratio where the content benefits, without forcing unrelated styles or adding decorative pictures. Match the material to the subject: oil black, limestone, sage, oxidised metal or brick can join warm ink/paper and selective amber. Choose light or dark grounds for the story, never force every image onto black with orange lighting.
- Ground concepts in SPECIFIC article details, not the SEO headline alone. Actual project names and company data inform which materials or mechanisms matter; depict a conceptual model or object, never fabricate photojournalism of a real named place, facility or event. A property topic can use relevant Australian building forms; no universal skyline, Australia map or gum-leaf badge.
- Every caption begins 'Illustration:' and names the conceptual subject/action in <=12 words. Never caption generated imagery as a photographed place, historical record or actual event. Preserve uncertainty: scrutiny is not proof of fraud, a squeeze candidate is not a promised squeeze, and qualitative illustration is not measured data.
- portrait ratio suits a tall physical subject; square suits object detail; landscape suits a grouped comparison or full-bleed action.
- Choose placement that reads well: "full" for the hero or a strong landscape comparison; "right"/"left" for portrait beside text; "inset" for a smaller square detail.
- Spread anchorAfterBlock across the article (never all at the start; never after the final block).
- NEVER request text, words, numbers, charts, graphs, logos, brand names, readable labels, people, money piles, bulls/bears, rockets, invented interfaces or decorative data fragments. Keep exact measurements in accessible article figures, outside generated artwork.
${EDITORIAL_CRAFT_RULES}
Return STRICT JSON per the schema.`;

export type PlanItem = Omit<LayoutImage, "url">;

/**
 * Enforce the exactly-one-hero invariant on an image plan (pure, testable):
 * - missing role defaults to "inline"
 * - no hero → promote the first landscape item (or the first item, forcing
 *   ratio to landscape) to role="hero"
 * - multiple heroes → keep the first, demote the rest to "inline"
 * - the hero is moved to index 0 (inline items keep their anchorAfterBlock,
 *   so body-anchor semantics are preserved; the hero ignores its anchor —
 *   it renders at the top of the page).
 */
export function normalisePlanRoles(items: PlanItem[]): PlanItem[] {
  if (items.length === 0) return [];
  const out = items.map((i) => ({ ...i, role: i.role === "hero" ? ("hero" as const) : ("inline" as const) }));
  const heroes = out.filter((i) => i.role === "hero");
  if (heroes.length === 0) {
    const cand = out.find((i) => i.ratio === "landscape") ?? out[0]!;
    cand.role = "hero";
    cand.ratio = "landscape";
  } else if (heroes.length > 1) {
    for (const extra of heroes.slice(1)) extra.role = "inline";
  }
  const heroIdx = out.findIndex((i) => i.role === "hero");
  const hero = out.splice(heroIdx, 1)[0]!;
  hero.ratio = "landscape";
  return [hero, ...out];
}

export async function designImagePlan(ai: GoogleGenerativeAI, ctx: ArtContext, count = 3): Promise<PlanItem[]> {
  const blocks = ctx.bodyMd.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  // Share a bounded prompt budget across the whole article rather than only
  // showing its opening. Include the same indices used by anchorAfterBlock.
  const labels = blocks.map((_, index) => `[${index}] `);
  const labelChars = labels.reduce((sum, label) => sum + label.length, 0) + Math.max(0, blocks.length - 1);
  const excerptChars = Math.min(400, Math.max(0, Math.floor((16_000 - labelChars) / Math.max(1, blocks.length))));
  const bodyExcerpts = blocks.map((block, index) => `${labels[index]}${block.trim().slice(0, excerptChars)}`).join("\n");
  const model = ai.getGenerativeModel({
    model: ART_MODEL(),
    systemInstruction: ART_SYSTEM,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: PLAN_SCHEMA,
      temperature: 0.85,
      maxOutputTokens: 2000,
      // gemini-3.5-flash spends its token budget on thinking unless disabled.
      ...( { thinkingConfig: { thinkingBudget: 0 } } as unknown as Record<string, unknown> ),
    } as unknown as Parameters<GoogleGenerativeAI["getGenerativeModel"]>[0]["generationConfig"],
  });
  const prompt = [
    `Article headline: ${ctx.headline}`,
    `Stock: ${ctx.stockCode} (sector: ${ctx.industry ?? "general market"})`,
    ctx.description ? `Company / project details: ${ctx.description.slice(0, 600)}` : "",
    ctx.dossierSummary ? `Investigation summary: ${ctx.dossierSummary}` : "",
    ctx.keyFacts?.length ? `Key facts: ${ctx.keyFacts.slice(0, 8).join("; ")}` : "",
    ctx.reportMetrics?.length ? `Reported financials: ${ctx.reportMetrics.slice(0, 8).join("; ")}` : "",
    "",
    `The article has ${blocks.length} body blocks (0-indexed, blank-line separated). Anchor images between them.`,
    `Article body excerpts by block (each may be truncated):\n${bodyExcerpts}`,
    "",
    `Design ${count} images. Return the JSON now.`,
  ].filter(Boolean).join("\n");
  const resp = await model.generateContent(prompt);
  let parsed: { images?: Array<PlanItem> };
  try { parsed = JSON.parse(resp.response.text()); } catch { return []; }
  const blocksN = blocks.length;
  const items = (parsed.images ?? [])
    .filter((im) => im && im.brief && STYLE_PROMPTS[im.style])
    .map((im) => ({
      ...im,
      caption: illustrationCaption(im.caption),
      anchorAfterBlock: Math.min(Math.max(0, Math.floor(im.anchorAfterBlock ?? 0)), Math.max(0, blocksN - 2)),
    }));
  return normalisePlanRoles(items);
}

export function sizeForRatio(ratio: string): "1536x1024" | "1024x1536" | "1024x1024" {
  if (ratio === "portrait") return "1024x1536";
  if (ratio === "square") return "1024x1024";
  return "1536x1024";
}

/** Render one plan spec via gpt-image-2 and return the PNG buffer. */
async function renderSpec(openai: OpenAI, spec: PlanItem, quality: ImageQuality): Promise<Buffer> {
  const stylePrefix = STYLE_PROMPTS[spec.style] ?? STYLE_PROMPTS.paper_collage;
  const prompt = `${stylePrefix}.

${EDITORIAL_CRAFT_RULES}

Conceptual subject and visual action (depict specifically): ${spec.brief}

STRICT: no text, words, numbers, letters, charts, graphs, logos, brand names, readable labels, people, fake interfaces or invented measured data. Clearly conceptual editorial illustration; never simulate photojournalism of an actual named location, facility or event.`;
  const resp = await openai.images.generate({ model: "gpt-image-2-2026-04-21", prompt, size: sizeForRatio(spec.ratio), quality, n: 1 });
  const b64 = resp.data?.[0]?.b64_json;
  if (!b64) throw new Error("empty image response");
  return Buffer.from(b64, "base64");
}

async function uploadPng(storage: Storage, objectPath: string, buf: Buffer): Promise<string> {
  await storage.bucket(GCS_BUCKET).file(objectPath).save(buf, { contentType: "image/png", resumable: false, metadata: { cacheControl: "public, max-age=86400" } });
  return `https://storage.googleapis.com/${GCS_BUCKET}/${objectPath}`;
}

/** Generate the planned INLINE images, upload to GCS, return full LayoutImage[].
 *  Pass only role='inline' items — the hero goes through generatePlanHero. */
export async function generatePlanImages(
  openai: OpenAI,
  storage: Storage,
  slug: string,
  plan: PlanItem[],
  opts: { quality?: ImageQuality } = {},
): Promise<{ images: LayoutImage[]; costUsd: number }> {
  const quality = opts.quality ?? "medium";
  const out: LayoutImage[] = [];
  let cost = 0;
  for (let i = 0; i < plan.length; i++) {
    const spec = plan[i]!;
    try {
      const buf = await renderSpec(openai, spec, quality);
      const url = await uploadPng(storage, `takes/${slug}-layout-${i + 1}.png`, buf);
      out.push({ ...spec, url });
      cost += 0.08;
    } catch (err) {
      console.warn(`[art-director] image ${i + 1} (${spec.style}/${spec.ratio}) failed: ${String((err as Error).message ?? err).slice(0, 120)}`);
    }
  }
  return { images: out, costUsd: cost };
}

/** Generate the plan's HERO image at high quality, upload to the canonical
 *  hero path (takes/{slug}-hero.png), return the full LayoutImage. */
export async function generatePlanHero(
  openai: OpenAI,
  storage: Storage,
  slug: string,
  spec: PlanItem,
  opts: { quality?: ImageQuality } = {},
): Promise<{ image: LayoutImage; costUsd: number }> {
  // Quality fallback. `high` at 1536x1024 is the only call in this pipeline
  // that fails consistently: the API drops the connection at ~180s (the SDK
  // surfaces it as "Connection error", which reads like a network blip and is
  // why it was mistaken for one). The default 600s client timeout is never
  // reached, so raising it does nothing.
  //
  // Losing the hero entirely is much worse than a medium-quality hero: the
  // article falls back to the generic brand OG, so the card and the social
  // preview stop being about the article at all. Try high, take medium if it
  // fails, and only give up if both do.
  const landscape = { ...spec, ratio: "landscape" as const };
  const wanted = opts.quality ?? "high";
  let buf: Buffer;
  let costUsd = 0.25; // gpt-image-2 high 1536x1024 est.
  try {
    buf = await renderSpec(openai, landscape, wanted);
  } catch (err) {
    if (wanted !== "high") throw err;
    console.warn(
      `[art-director]   hero at high quality failed (${String((err as Error).message ?? err).slice(0, 60)}) — retrying at medium`,
    );
    buf = await renderSpec(openai, landscape, "medium");
    costUsd = 0.075; // gpt-image-2 medium 1536x1024 est.
  }
  const url = await uploadPng(storage, `takes/${slug}-hero.png`, buf);
  return { image: { ...landscape, role: "hero", url }, costUsd };
}

/**
 * Generate a SINGLE layout image from a full spec (style/ratio/brief/caption/
 * placement/anchor), upload to GCS at the canonical layout path, and return the
 * full LayoutImage. Used by the validator's auto-fix loop to re-generate one
 * flagged image in place.
 */
export async function generateOneLayoutImage(
  openai: OpenAI,
  storage: Storage,
  slug: string,
  index: number,
  spec: PlanItem,
  opts: { quality?: ImageQuality } = {},
): Promise<LayoutImage> {
  const buf = await renderSpec(openai, spec, opts.quality ?? "medium");
  const url = await uploadPng(storage, `takes/${slug}-layout-${index + 1}.png`, buf);
  return { ...spec, url };
}
