import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import OpenAI from "openai";
import { Storage } from "@google-cloud/storage";

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
  documentary: "Documentary news photograph. 35mm lens, natural available light, shallow depth of field, off-centre composition with leading lines, Reuters/Bloomberg wire-photo realism, true-to-life colour. NOT: text, charts, logos, readable signage, recognisable faces, watermarks, illustration look, oversaturation, HDR halos.",
  aerial: "Aerial photograph, golden-hour low sun, long shadows, three-quarter oblique angle (not straight down), atmospheric haze toward the horizon, sense of scale from human-made structures. NOT: text, logos, map labels, drone visible in frame, fisheye distortion, miniature/tilt-shift effect.",
  still_life: "Editorial still life. Single warm key light from upper left, deep soft shadows, macro detail on material texture, objects on raw stone or brushed steel surface, restrained dark palette with one warm accent. NOT: text, labels, logos, hands, lifestyle props, white studio background.",
  isometric: "Clean isometric 3D render, translucent layered materials, single amber accent light against near-black, precise geometry, soft global illumination, subtle depth-of-field falloff at edges. NOT: text, numbers, axis labels, cartoon style, bright saturated palette, visible UI elements.",
  archival: "Archival press photograph, grainy black-and-white or faded period-correct colour, period-correct equipment and dress, slight vignetting, scanned-print texture. NOT: text overlays, modern objects, digital sharpness, watermarks, recognisable faces in close-up.",
  abstract: "Abstract editorial art: folded paper planes, layered gradients, or long-exposure light forms; brand amber (#FFA94D) accents on near-black (#0a0a0a); generous negative space; matte finish. NOT: text, charts, dollar signs, bulls or bears, logos, glossy 3D chrome, stock-photo clichés.",
  environmental: "Wide environmental establishing shot, 24mm lens, overcast or dusk light, human-scale but figures distant and anonymous, industrial or landscape context dominating the frame, muted cinematic grade. NOT: text, signage close-ups, logos, recognisable faces, dramatic sky HDR, lens flare.",
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
          brief: { type: SchemaType.STRING, description: "One concrete, specific photographic/illustrative subject tied to THIS article — use real place names, project names, materials, facilities, or events from the content. No text, charts, logos, readable labels, or recognisable faces." },
          caption: { type: SchemaType.STRING, description: "Short editorial caption (<=12 words), factual, no period needed." },
          placement: { type: SchemaType.STRING, enum: ["full", "left", "right", "inset"], format: "enum" },
          anchorAfterBlock: { type: SchemaType.NUMBER, description: "0-based index of the body block (blank-line-separated) AFTER which to place this image." },
        },
        required: ["role", "style", "ratio", "brief", "caption", "placement", "anchorAfterBlock"],
      },
    },
  },
  required: ["images"],
};

const ART_SYSTEM = `You are the art director for Shorted, a sharp financial publication. Design a varied, editorial set of images for one article. Rules:
- The FIRST image is the HERO: role='hero', ratio='landscape', documentary or environmental style, the single most arresting concrete subject from the dossier (a real project, site, material, or location). It must work as the page-top image of a serious financial masthead. Its caption is a proper news caption (what/where), not marketing copy. Every other image is role='inline'.
- VARY the styles and ratios across the set — never all the same. Match style to content: aerial/environmental for sites & locations, documentary for events, still_life for materials/objects, isometric/abstract for data or concepts, archival for history.
- Ground every brief in SPECIFIC real details from the article and company data — name the actual place, project, facility, material, or event (e.g. "the Kayelekera open-pit uranium mine in northern Malawi", not "a mine").
- portrait ratio suits a single tall subject or person-free environmental shot; square suits objects/detail; landscape suits scenes/aerials/full-bleed.
- Choose placement that reads well: "full" for a strong landscape/aerial; "right"/"left" for portrait beside text; "inset" for a smaller square detail.
- Spread anchorAfterBlock across the article (never all at the start; never after the final block).
- NEVER request text, words, numbers, charts, graphs, logos, brand names, readable labels, or recognisable human faces in any image.
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
  const stylePrefix = STYLE_PROMPTS[spec.style] ?? STYLE_PROMPTS.documentary;
  const prompt = `${stylePrefix}.

Subject (depict specifically): ${spec.brief}

STRICT: no text, words, numbers, letters, charts, graphs, logos, brand names, readable labels, or recognisable human faces.`;
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
