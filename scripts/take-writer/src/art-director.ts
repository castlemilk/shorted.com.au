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
}

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

const STYLE_PROMPTS: Record<string, string> = {
  documentary: "Documentary news photograph, natural available light, photojournalistic realism, candid, 35mm",
  aerial: "High-altitude aerial / satellite-style view from directly above, cartographic clarity, terrain and infrastructure",
  still_life: "Studio still-life, dramatic single-source lighting, deep shadow, tactile materials, high detail",
  isometric: "Isometric 3D illustration, clean matte vector-like surfaces, muted editorial palette, soft ambient occlusion",
  archival: "Grainy desaturated archival photograph, vintage film stock, faded contrast, mid-20th-century print feel",
  abstract: "Abstract conceptual composition, bold minimal forms, generous negative space, editorial art direction",
  environmental: "Environmental wide shot of a place or facility, shallow depth of field, atmospheric, sense of scale",
};

const PLAN_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    images: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          style: { type: SchemaType.STRING, enum: Object.keys(STYLE_PROMPTS), format: "enum" },
          ratio: { type: SchemaType.STRING, enum: ["landscape", "portrait", "square"], format: "enum" },
          brief: { type: SchemaType.STRING, description: "One concrete, specific photographic/illustrative subject tied to THIS article — use real place names, project names, materials, facilities, or events from the content. No text, charts, logos, readable labels, or recognisable faces." },
          caption: { type: SchemaType.STRING, description: "Short editorial caption (<=12 words), factual, no period needed." },
          placement: { type: SchemaType.STRING, enum: ["full", "left", "right", "inset"], format: "enum" },
          anchorAfterBlock: { type: SchemaType.NUMBER, description: "0-based index of the body block (blank-line-separated) AFTER which to place this image." },
        },
        required: ["style", "ratio", "brief", "caption", "placement", "anchorAfterBlock"],
      },
    },
  },
  required: ["images"],
};

const ART_SYSTEM = `You are the art director for Shorted, a sharp financial publication. Design a varied, editorial set of images for one article. Rules:
- VARY the styles and ratios across the set — never all the same. Match style to content: aerial/environmental for sites & locations, documentary for events, still_life for materials/objects, isometric/abstract for data or concepts, archival for history.
- Ground every brief in SPECIFIC real details from the article and company data — name the actual place, project, facility, material, or event (e.g. "the Kayelekera open-pit uranium mine in northern Malawi", not "a mine").
- portrait ratio suits a single tall subject or person-free environmental shot; square suits objects/detail; landscape suits scenes/aerials/full-bleed.
- Choose placement that reads well: "full" for a strong landscape/aerial; "right"/"left" for portrait beside text; "inset" for a smaller square detail.
- Spread anchorAfterBlock across the article (never all at the start; never after the final block).
- NEVER request text, words, numbers, charts, graphs, logos, brand names, readable labels, or recognisable human faces in any image.
Return STRICT JSON per the schema.`;

export async function designImagePlan(ai: GoogleGenerativeAI, ctx: ArtContext, count = 3): Promise<Omit<LayoutImage, "url">[]> {
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
  let parsed: { images?: Array<Omit<LayoutImage, "url">> };
  try { parsed = JSON.parse(resp.response.text()); } catch { return []; }
  const blocksN = blocks.length;
  return (parsed.images ?? [])
    .filter((im) => im && im.brief && STYLE_PROMPTS[im.style])
    .map((im) => ({
      ...im,
      anchorAfterBlock: Math.min(Math.max(0, Math.floor(im.anchorAfterBlock ?? 0)), Math.max(0, blocksN - 2)),
    }));
}

function sizeForRatio(ratio: string): "1536x1024" | "1024x1536" | "1024x1024" {
  if (ratio === "portrait") return "1024x1536";
  if (ratio === "square") return "1024x1024";
  return "1536x1024";
}

/** Generate the planned images, upload to GCS, return full LayoutImage[]. */
export async function generatePlanImages(
  openai: OpenAI,
  storage: Storage,
  slug: string,
  plan: Omit<LayoutImage, "url">[],
): Promise<{ images: LayoutImage[]; costUsd: number }> {
  const out: LayoutImage[] = [];
  let cost = 0;
  for (let i = 0; i < plan.length; i++) {
    const spec = plan[i]!;
    const stylePrefix = STYLE_PROMPTS[spec.style] ?? STYLE_PROMPTS.documentary;
    const prompt = `${stylePrefix}.

Subject (depict specifically): ${spec.brief}

STRICT: no text, words, numbers, letters, charts, graphs, logos, brand names, readable labels, or recognisable human faces.`;
    try {
      const resp = await openai.images.generate({ model: "gpt-image-2-2026-04-21", prompt, size: sizeForRatio(spec.ratio), quality: "medium", n: 1 });
      const b64 = resp.data?.[0]?.b64_json;
      if (!b64) throw new Error("empty image response");
      const buf = Buffer.from(b64, "base64");
      const objectPath = `takes/${slug}-layout-${i + 1}.png`;
      await storage.bucket(GCS_BUCKET).file(objectPath).save(buf, { contentType: "image/png", resumable: false, metadata: { cacheControl: "public, max-age=86400" } });
      out.push({ ...spec, url: `https://storage.googleapis.com/${GCS_BUCKET}/${objectPath}` });
      cost += 0.08;
    } catch (err) {
      console.warn(`[art-director] image ${i + 1} (${spec.style}/${spec.ratio}) failed: ${String((err as Error).message ?? err).slice(0, 120)}`);
    }
  }
  return { images: out, costUsd: cost };
}
