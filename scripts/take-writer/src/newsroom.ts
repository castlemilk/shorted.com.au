// Newsroom loop — the daily journalist run.
//
// 1. Build the agenda (rank story candidates by signal strength)
// 2. For each pick: run the journalism narrative synthesis
// 3. Optionally generate a hero image via gpt-image-2 + GCS
// 4. Insert as draft (default) or publish (--auto-publish)
// 5. Report which stories landed and where to review them
//
// Designed to be invoked on demand from the terminal — the operator
// runs it when they want fresh editorial, reviews the drafts at
// /admin/takes, and publishes the ones worth tweeting.

import { Client as PgClient } from "pg";
import OpenAI from "openai";
import { Storage } from "@google-cloud/storage";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildAgenda, type AgendaCandidate, type AgendaAngle } from "./agenda.js";
import { synthesiseNarrative, narrativeToBodyMd, type NarrativeTake, synthesiseFromDossier, type DossierTake } from "./narrative.js";
import { commissionAssignments, type Assignment } from "./editor.js";
import { investigate, type GeminiGenerate } from "./investigator.js";
import { CitationLedger } from "./ledger.js";
import { getOverview } from "./drilldowns.js";
import { designImagePlan, generatePlanImages, type ArtContext, type LayoutImage } from "./art-director.js";

function makeGeminiGenerate(ai: GoogleGenerativeAI, modelName: string): GeminiGenerate {
  return async ({ systemInstruction, tools, contents }) => {
    const model = ai.getGenerativeModel({ model: modelName, systemInstruction, tools: [{ functionDeclarations: tools }] });
    const result = await model.generateContent({ contents });
    return {
      functionCalls: () =>
        result.response.functionCalls()?.map((fc) => ({ name: fc.name, args: (fc.args ?? {}) as Record<string, unknown> })),
      modelContent: () => result.response.candidates?.[0]?.content ?? { role: "model", parts: [] },
    };
  };
}

const GCS_BUCKET = process.env.GCS_LOGO_BUCKET ?? "shorted-company-logos";
const SITE_URL = process.env.SHORTED_SITE_URL ?? "https://shorted.com.au";

export interface NewsroomOptions {
  poolSize?: number;
  topN: number;
  autoPublish: boolean;
  withImages: boolean;
  minScore?: number;
}

interface NewsroomResult {
  stockCode: string;
  score: number;
  angle: AgendaAngle;
  slug?: string;
  headline?: string;
  heroUrl?: string;
  status: "drafted" | "published" | "skipped" | "failed";
  error?: string;
  costUsd: number;
  ms: number;
}

const BRAND_PROMPT = `Editorial illustration in the style of a modern financial publication.
Visual style: dark background (near-black #0a0a0a) with selective orange
accents (#FFA94D). Minimal, clean, composition-driven. Subtle grain or noise
acceptable. High contrast.

NEVER include text, words, numbers, letters, charts, graphs, bars, lines,
percentages, cityscapes, skylines, businessmen, faces, hands, arrows,
rockets, bulls, bears, dollar signs, handshakes, money stacks.

Preferred: photorealistic close-up of a physical industrial subject;
isometric/geometric data abstraction; raw materials; document close-ups
(blank, no readable text); architectural interiors; mining or processing
equipment from unconventional angles.

Lighting: low-key, deep shadow, single warm amber light source.

Topic to illustrate:`;

const FINAL_RULES = `

CRITICAL FINAL RULES — apply these to the image you generate:
1. Do NOT add any charts, graphs, bars, lines, percentages, numbers,
   ticker symbols, currency symbols, or other data visualisation
   elements — even if the topic mentions a document.
2. Do NOT add any text, words, letters, or numbers in the image.
3. Do NOT add any people, faces, silhouettes, hands, or figures.
4. Do NOT add any city skylines or recognisable architecture.
5. Keep the composition minimal — single subject, deep negative space,
   low-key lighting, one warm orange/amber light source.`;

// Sector-appropriate subject vocabulary for the hero prompt. The
// previous prompt biased toward industrial materials regardless of
// company sector (Endeavour Group — a liquor retailer — got an ore
// chunk). Subject hints are passed through to gpt-image-2 as
// suggestions, with the brand aesthetic (dark + amber, no text/people)
// holding constant.
function subjectHintForIndustry(industry: string | null): string {
  const i = (industry ?? "").toLowerCase();
  if (i.includes("material") || i.includes("metal") || i.includes("mining")) {
    return "a chunk of raw ore, ingot, drill core, or processed metal";
  }
  if (i.includes("energy") || i.includes("utilities")) {
    return "a single industrial pipe fitting, valve, transformer coil, or oil drum";
  }
  if (i.includes("capital goods") || i.includes("industrial") || i.includes("aerospace") || i.includes("defence")) {
    return "a tactical electronics enclosure, machined metal component, or industrial sensor housing";
  }
  if (i.includes("consumer staples") || i.includes("food") || i.includes("beverage")) {
    return "a single dark-glass bottle, a stacked retail crate, or a polished bar surface — products lit moodily, no readable labels";
  }
  if (i.includes("consumer discretionary") || i.includes("retail") || i.includes("hospitality") || i.includes("travel")) {
    return "a luxury product still-life: a leather travel case, a hotel key, a folded garment, or shop fixtures in low light";
  }
  if (i.includes("financial") || i.includes("bank") || i.includes("insurance")) {
    return "a leather ledger, a sealed envelope, a vault door fragment, a single wax-sealed document — no readable text";
  }
  if (i.includes("health") || i.includes("biotech") || i.includes("pharma")) {
    return "a single laboratory vial, glass ampoule, scientific instrument component, or sterile petri dish — no labels";
  }
  if (i.includes("technology") || i.includes("software") || i.includes("communication")) {
    return "a circuit board fragment, fibre-optic bundle, or anodised heatsink — macro detail, no logos";
  }
  if (i.includes("real estate") || i.includes("property")) {
    return "an architectural model fragment, concrete sample block, or scaled construction detail";
  }
  // Fallback — abstract geometric data art (works for any sector, never wrong)
  return "an abstract geometric form: a single matte sphere, stacked panels, folded paper sculpture, or layered gradients — no objects from any specific industry";
}

const INLINE_BRIEF_MODEL = () => process.env.INLINE_BRIEF_MODEL ?? "gemini-3.5-flash";

/** Turn an article section into a concrete, photographic image concept
 *  tied to its specific subject/mood. Falls back to the industry hint on
 *  any error so image generation never hard-fails on the brief step. */
/** Reject preamble / markdown / mid-fragment junk and keep only a clean
 *  first sentence. Returns null if what's left isn't a usable scene. */
function sanitiseBrief(raw: string): string | null {
  let s = raw.trim().replace(/^["']|["']$/g, "").trim();
  // Drop obvious instruction-echo / preamble lines.
  if (/\b(restrictions?|do not|output only|no preamble)\b/i.test(s)) return null;
  if (s.includes("**") || s.includes("##")) return null;
  // Drop a leading markdown bullet/heading marker if present.
  s = s.replace(/^[#>*\-\s]+/, "").trim();
  // Keep only the first sentence.
  const m = s.match(/^.*?[.!?](\s|$)/);
  if (m) s = m[0].trim();
  // Reject mid-fragment starts (lowercase opener or stray close-paren).
  if (/^[a-z)]/.test(s)) return null;
  if (s.includes(")") && !s.includes("(")) return null;
  return s.length > 15 ? s : null;
}

async function visualBriefForSection(
  ai: GoogleGenerativeAI,
  stockCode: string,
  industry: string | null,
  sectionText: string,
): Promise<string> {
  try {
    const model = ai.getGenerativeModel({
      model: INLINE_BRIEF_MODEL(),
      // gemini-3.5-flash burns its whole output budget on thinking tokens
      // unless thinking is disabled — without thinkingBudget:0 the brief
      // truncates to a few words (finishReason MAX_TOKENS). The cast is
      // because the SDK's GenerationConfig type predates thinkingConfig;
      // the field is forwarded to the API at runtime.
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 400,
        thinkingConfig: { thinkingBudget: 0 },
      } as unknown as Parameters<GoogleGenerativeAI["getGenerativeModel"]>[0]["generationConfig"],
    });
    const prompt = `You are an art director for a financial publication. Read this excerpt from an article about ${stockCode} (sector: ${industry ?? "general market"}).

In ONE vivid sentence, describe a single concrete, photographic image that captures THIS excerpt's specific subject or mood — a real scene, object, material, or environment directly tied to what's described (e.g. a halted mine head-frame under ash-grey sky, scattered legal documents on a dark desk, an empty boardroom chair, a sealed laboratory vial, a darkened retail floor). Make it specific to the events, not generic.

It will be shot dark and cinematic with a single warm amber light source. Do NOT mention text, words, numbers, charts, graphs, logos, brand names, readable labels, or human faces. Output ONLY the sentence, no preamble.

Excerpt:
${sectionText.slice(0, 900)}`;
    const resp = await model.generateContent(prompt);
    const brief = sanitiseBrief(resp.response.text());
    return brief ?? subjectHintForIndustry(industry);
  } catch {
    return subjectHintForIndustry(industry);
  }
}

/** Split a body into the sections inline images should illustrate.
 *  Deep-dives: one section per "## heading" (heading + its prose).
 *  Takes: top-level paragraphs. Returns `count` sections spread across
 *  the article. */
function pickSections(bodyMd: string, count: number): string[] {
  const trimmed = bodyMd.trim();
  let sections: string[];
  if (/^##\s/m.test(trimmed)) {
    // Split on headings, keep heading + following prose together.
    sections = trimmed
      .split(/\n(?=##\s)/)
      .map((s) => s.replace(/^#+\s*/, "").trim())
      .filter((s) => s.length > 0);
  } else {
    sections = trimmed.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (sections.length === 0) return [];
  // Spread the picks evenly across available sections.
  const out: string[] = [];
  const stepF = sections.length / (count + 1);
  for (let i = 1; i <= count; i++) {
    const idx = Math.min(sections.length - 1, Math.max(0, Math.round(i * stepF) - 1));
    out.push(sections[idx]!);
  }
  return out;
}

// Visual treatment variants — same brand DNA (dark + warm amber, no
// text/people/logos) but very different compositions. We rotate by
// deterministic hash on slug so each take gets a distinct look from
// its neighbours on /news, but the same take always renders the same
// way (idempotent regens).
type Treatment = {
  name: string;
  composition: string;
  mood: string;
};

const TREATMENTS: Treatment[] = [
  {
    name: "close-up-object",
    composition: "Macro photograph of the subject filling about 40% of the frame, off-centre, dramatic single-side amber rim light, deep shadow on the other side, dark textured surface beneath",
    mood: "tactile, weighty, considered",
  },
  {
    name: "wide-architectural",
    composition: "Wide-angle architectural still life of the subject in a much larger empty interior space, single amber light source raking across textured walls, strong negative space",
    mood: "cinematic, austere, late-day",
  },
  {
    name: "abstract-geometric",
    composition: "Abstract geometric still life — folded paper, stacked dark panels, layered gradient surfaces, isometric blocks — single warm amber light, no recognisable real objects",
    mood: "design-magazine, restrained, art-school",
  },
  {
    name: "atmospheric-environment",
    composition: "Atmospheric environment shot with the subject partly obscured by haze, smoke, or low fog — single distant amber light source, painterly, deep shadow",
    mood: "moody, suggestive, ambient",
  },
  {
    name: "topdown-still-life",
    composition: "Top-down flat-lay composition on dark stone or weathered metal — subject + two or three related supporting elements arranged with intentional negative space, hard side-light",
    mood: "editorial magazine spread, deliberate, museum-like",
  },
  {
    name: "isometric-data-art",
    composition: "Isometric 3D render — stacked translucent slabs, ribbed columns, gradient walls — referencing data visualisation aesthetics without any actual data, charts, numbers or text",
    mood: "modern, slightly cold, architectural",
  },
];

function pickTreatment(seed: string): Treatment {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return TREATMENTS[(h >>> 0) % TREATMENTS.length]!;
}

// Pick N distinct treatments, deterministic on slug. Used by hero +
// inline image generation so a single Take has variety inside it.
function pickTreatments(slug: string, n: number): Treatment[] {
  const out: Treatment[] = [];
  for (let i = 0; i < n; i++) {
    const t = pickTreatment(`${slug}-v${i}`);
    if (!out.some((x) => x.name === t.name)) {
      out.push(t);
    } else {
      // Collision — walk through the array to find an unused one
      const idx = TREATMENTS.findIndex((x) => !out.some((y) => y.name === x.name));
      if (idx >= 0) out.push(TREATMENTS[idx]!);
    }
  }
  return out;
}

async function generateHero(
  openai: OpenAI,
  storage: Storage,
  candidate: AgendaCandidate,
  take: NarrativeTake,
): Promise<{ url: string; costUsd: number }> {
  const subjectHint = subjectHintForIndustry(candidate.industry);
  // Use the first picked treatment for the hero; inline images use the rest.
  const treatment = pickTreatments(take.slug, 1)[0]!;
  const topic = `Editorial illustration for an article about ASX: ${candidate.stockCode} (sector: ${candidate.industry ?? "general market"}). Headline angle: ${take.headline}.

Subject vocabulary: ${subjectHint}.

Composition treatment: ${treatment.composition}.
Mood: ${treatment.mood}.

The image must read at a glance as related to the company's industry and the headline's angle. No text, no charts, no people, no logos, no recognisable architecture or skylines.`;
  const prompt = `${BRAND_PROMPT}\n\n${topic}\n\nFormat: 16:9 horizontal hero banner composition.${FINAL_RULES}`;

  const resp = await openai.images.generate({
    model: "gpt-image-2-2026-04-21",
    prompt,
    size: "1536x1024",
    quality: "medium",
    n: 1,
  });
  const b64 = resp.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image data");
  const buf = Buffer.from(b64, "base64");

  const objectPath = `takes/${take.slug}-hero.png`;
  await storage.bucket(GCS_BUCKET).file(objectPath).save(buf, {
    contentType: "image/png",
    resumable: false,
    metadata: { cacheControl: "public, max-age=86400" },
  });
  return {
    url: `https://storage.googleapis.com/${GCS_BUCKET}/${objectPath}`,
    costUsd: 0.075, // gpt-image-2 medium 1536×1024 est.
  };
}

interface InlineImageRow {
  url: string;
  topic: string;
  alt: string;
}

async function generateInlineImages(
  openai: OpenAI,
  storage: Storage,
  ai: GoogleGenerativeAI,
  candidate: AgendaCandidate,
  take: NarrativeTake,
  bodyMd: string,
  count = 2,
): Promise<{ images: InlineImageRow[]; costUsd: number }> {
  // Unlike the hero (an abstract brand thumbnail), inline images are
  // CONTEXTUAL: each illustrates a specific article section. We derive a
  // concrete photographic "visual brief" from the section's text via
  // Gemini, then render that real scene — still dark + cinematic + single
  // warm amber light, but story-specific rather than generic brand-abstract.
  //
  // Treatments still vary composition; we skip the first (the hero's) so
  // inline pictures don't visually echo the hero.
  const sections = pickSections(bodyMd, count);
  const treatments = pickTreatments(take.slug, count + 1).slice(1);
  const out: InlineImageRow[] = [];
  let totalCost = 0;
  for (let i = 0; i < count; i++) {
    const sectionText = sections[i] ?? sections[sections.length - 1] ?? take.headline;
    const treatment = treatments[i] ?? treatments[0]!;
    const brief = await visualBriefForSection(ai, candidate.stockCode, candidate.industry, sectionText);
    const prompt = `Editorial photograph for a financial publication, dark and cinematic.

Subject (depict this specifically): ${brief}

Composition: ${treatment.composition}.
Mood: ${treatment.mood}. Near-black background (#0a0a0a) with a single warm amber (#FFA94D) light source, deep shadow, high contrast, subtle grain.

STRICT: no text, words, numbers, letters, charts, graphs, percentages, logos, brand names, readable labels, ticker symbols, or recognisable human faces. A real, evocative scene tied to the subject above.

Format: 16:9 horizontal banner.`;
    try {
      const resp = await openai.images.generate({
        model: "gpt-image-2-2026-04-21",
        prompt,
        size: "1536x1024",
        quality: "medium",
        n: 1,
      });
      const b64 = resp.data?.[0]?.b64_json;
      if (!b64) throw new Error("empty image response");
      const buf = Buffer.from(b64, "base64");
      const objectPath = `takes/${take.slug}-inline-${i + 1}.png`;
      await storage.bucket(GCS_BUCKET).file(objectPath).save(buf, {
        contentType: "image/png",
        resumable: false,
        metadata: { cacheControl: "public, max-age=86400" },
      });
      out.push({
        url: `https://storage.googleapis.com/${GCS_BUCKET}/${objectPath}`,
        topic: brief.slice(0, 80),
        alt: brief.slice(0, 140),
      });
      totalCost += 0.075;
    } catch (err) {
      // Inline image failures are non-fatal — the article still ships
      // with the hero. Log and continue.
      console.warn(`[newsroom]   inline-${i + 1} failed: ${String((err as Error).message ?? err).slice(0, 120)}`);
    }
  }
  return { images: out, costUsd: totalCost };
}

async function insertTake(
  pg: PgClient,
  candidate: AgendaCandidate,
  take: NarrativeTake,
  bodyMd: string,
  heroUrl: string | null,
  inlineImages: InlineImageRow[],
  publish: boolean,
): Promise<void> {
  const publishedClause = publish ? "NOW()" : "NULL";
  await pg.query(
    `INSERT INTO editorial_takes (
       slug, headline, stock_code, body_md, sentiment, word_count, model,
       citations, hero_image_url, inline_images, published_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'gemini-2.5-flash',$7::jsonb,$8,$9::jsonb,${publishedClause})
     ON CONFLICT (slug) DO UPDATE SET
       headline=EXCLUDED.headline, body_md=EXCLUDED.body_md,
       sentiment=EXCLUDED.sentiment, word_count=EXCLUDED.word_count,
       citations=EXCLUDED.citations,
       hero_image_url=COALESCE(EXCLUDED.hero_image_url, editorial_takes.hero_image_url),
       inline_images=CASE WHEN jsonb_array_length(EXCLUDED.inline_images) > 0
                          THEN EXCLUDED.inline_images
                          ELSE editorial_takes.inline_images END,
       updated_at=NOW()`,
    [
      take.slug, take.headline, candidate.stockCode,
      bodyMd, take.sentiment, bodyMd.split(/\s+/).filter(Boolean).length,
      JSON.stringify(take.citations), heroUrl,
      JSON.stringify(inlineImages),
    ],
  );
}

/** Hold a piece as a draft (don't auto-publish) when grounding is weak:
 *  any dangling citation the writer invented, OR zero retrieved-source
 *  citations at all (regardless of tier). Never auto-publish ungrounded
 *  claims about a named company — a human reviews held drafts.
 *  NOTE: this gates on citation MARKERS resolving, not on every claim
 *  being cited — an uncited invented number can still pass. Claim-level
 *  grounding is the model's responsibility via the system prompt. */
export function shouldHoldAsDraft(t: { droppedCitations: string[]; citations: unknown[]; tier?: "take" | "deep_dive" }): boolean {
  if (t.droppedCitations.length > 0) return true;
  if (t.citations.length === 0) return true;
  return false;
}

async function insertDossierTake(
  pg: PgClient,
  take: DossierTake,
  stockCode: string,
  heroUrl: string | null,
  inlineImages: InlineImageRow[],
  layoutImages: LayoutImage[],
  publish: boolean,
  writerModel: string,
): Promise<void> {
  const publishedClause = publish ? "NOW()" : "NULL";
  // ON CONFLICT preserves published_at: re-runs never silently flip a reviewed draft's publish state.
  await pg.query(
    `INSERT INTO editorial_takes (
       slug, headline, stock_code, body_md, sentiment, word_count, model, tier,
       citations, hero_image_url, inline_images, layout_images, published_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,${publishedClause})
     ON CONFLICT (slug) DO UPDATE SET
       headline=EXCLUDED.headline, body_md=EXCLUDED.body_md, tier=EXCLUDED.tier,
       sentiment=EXCLUDED.sentiment, word_count=EXCLUDED.word_count,
       citations=EXCLUDED.citations,
       hero_image_url=COALESCE(EXCLUDED.hero_image_url, editorial_takes.hero_image_url),
       inline_images=CASE WHEN jsonb_array_length(EXCLUDED.inline_images) > 0
                          THEN EXCLUDED.inline_images ELSE editorial_takes.inline_images END,
       layout_images=CASE WHEN jsonb_array_length(EXCLUDED.layout_images) > 0
                          THEN EXCLUDED.layout_images ELSE editorial_takes.layout_images END,
       updated_at=NOW()`,
    [
      take.slug, take.headline, stockCode, take.bodyMd, take.sentiment,
      take.bodyMd.split(/\s+/).filter(Boolean).length, writerModel, take.tier,
      JSON.stringify(take.citations), heroUrl, JSON.stringify(inlineImages),
      JSON.stringify(layoutImages),
    ],
  );
}

export interface DailyOptions {
  poolSize?: number;
  maxTakes?: number;
  maxDeepDives?: number;
  autoPublish: boolean;
  withImages: boolean;
}

export async function runNewsroomDaily(opts: DailyOptions): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  if (opts.withImages && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set (required for --with-images)");
  }

  const takeModel = process.env.INVESTIGATOR_MODEL_TAKE ?? "gemini-3.5-flash";
  const deepModel = process.env.INVESTIGATOR_MODEL_DEEPDIVE ?? "gemini-3.5-flash";
  const maxTurnsTake = Number(process.env.MAX_TURNS_TAKE ?? 6);
  const maxTurnsDeep = Number(process.env.MAX_TURNS_DEEPDIVE ?? 14);

  const pg = new PgClient({ connectionString: dbUrl });
  await pg.connect();
  const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

  let openai: OpenAI | null = null;
  let storage: Storage | null = null;
  if (opts.withImages) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not set (required for --with-images)");
    openai = new OpenAI({ apiKey: key });
    storage = new Storage();
  }

  let totalCost = 0;
  let published = 0, drafted = 0, held = 0, failed = 0;

  try {
    console.log(`\n[newsroom-daily] commissioning (pool ${opts.poolSize ?? 30}, <=${opts.maxTakes ?? 10} takes, <=${opts.maxDeepDives ?? 2} deep-dives)...`);
    const assignments = await commissionAssignments(pg, {
      poolSize: opts.poolSize,
      maxTakes: opts.maxTakes,
      maxDeepDives: opts.maxDeepDives,
    });
    if (assignments.length === 0) {
      console.log("[newsroom-daily] nothing new to cover today.");
      return;
    }
    console.log(`[newsroom-daily] ${assignments.length} assignments:`);
    for (const a of assignments) console.log(`  - ${a.stockCode} [${a.tier}] ${a.angle}`);

    for (const [i, a] of assignments.entries()) {
      const tag = `[${i + 1}/${assignments.length}] ${a.stockCode}`;
      const t0 = Date.now();
      try {
        const ledger = new CitationLedger();
        const dossier = await investigate(makeGeminiGenerate(ai, a.tier === "deep_dive" ? deepModel : takeModel), pg, a, ledger, {
          maxTurns: a.tier === "deep_dive" ? maxTurnsDeep : maxTurnsTake,
        });
        const writerModel = a.tier === "deep_dive"
          ? (process.env.WRITER_MODEL_DEEPDIVE ?? process.env.WRITER_MODEL ?? "gemini-2.5-flash")
          : (process.env.WRITER_MODEL ?? "gemini-2.5-flash");
        const overview = await getOverview(pg, a.stockCode).catch(() => null);
        const take = await synthesiseFromDossier(dossier, ledger, a.stockCode, overview);
        console.log(`${tag} -> "${take.headline}" (${take.citations.length} cites, ${take.droppedCitations.length} dropped)`);

        const hold = shouldHoldAsDraft(take);
        if (hold) {
          console.warn(`${tag}   weak grounding (dropped ${take.droppedCitations.join(",") || "none"}; ${take.citations.length} cites) — held as draft`);
        }
        const publishThis = opts.autoPublish && !hold;

        let heroUrl: string | null = null;
        let inlineImages: InlineImageRow[] = [];
        let layoutImages: LayoutImage[] = [];
        if (opts.withImages && openai && storage) {
          const candidate = { stockCode: a.stockCode, industry: a.industry } as unknown as AgendaCandidate;
          const narrativeShim = { slug: take.slug, headline: take.headline } as unknown as NarrativeTake;
          const img = await generateHero(openai, storage, candidate, narrativeShim);
          heroUrl = img.url; totalCost += img.costUsd;
          const inl = await generateInlineImages(openai, storage, ai, candidate, narrativeShim, take.bodyMd, 2);
          inlineImages = inl.images; totalCost += inl.costUsd;

          // Art-director stage — content-grounded varied layout images.
          try {
            const artCtx: ArtContext = {
              stockCode: a.stockCode,
              headline: take.headline,
              industry: a.industry,
              description: null,
              bodyMd: take.bodyMd,
              dossierSummary: dossier.summary,
              keyFacts: dossier.threads
                .map((t) => t.claim)
                .concat(dossier.keyNumbers.map((n) => `${n.label}: ${n.value}`)),
            };
            const plan = await designImagePlan(ai, artCtx, 3);
            const gen = await generatePlanImages(openai, storage, take.slug, plan);
            layoutImages = gen.images; totalCost += gen.costUsd;
          } catch (err) {
            console.warn(`${tag}   art-director failed: ${String((err as Error).message ?? err).slice(0, 120)}`);
          }
        }

        await insertDossierTake(pg, take, a.stockCode, heroUrl, inlineImages, layoutImages, publishThis, writerModel);
        if (publishThis) published++;
        else if (hold) held++;
        else drafted++;
        console.log(`${tag}   ${publishThis ? "published" : "draft"} /news/${take.slug} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (err) {
        failed++;
        console.log(`${tag}   FAILED: ${String((err as Error).message ?? err).slice(0, 160)}`);
      }
    }
  } finally {
    await pg.end();
  }

  console.log("\n=== Newsroom-daily briefing ===");
  console.log(`  published: ${published}  drafted: ${drafted}  held(weak grounding): ${held}  failed: ${failed}`);
  console.log(`  image cost: $${totalCost.toFixed(3)} (LLM token cost logged by providers)`);
}

export interface PreviewOptions {
  stockCode: string;
  tier: "take" | "deep_dive";
  angle?: string;
}

/** Run editor-less investigate -> write for ONE stock and print the full
 *  dossier + rendered body + citations to stdout. Does NOT insert into
 *  editorial_takes and does NOT generate images — safe to point at a
 *  read-only/prod DB for judging output quality. */
export async function runNewsroomPreview(opts: PreviewOptions): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

  const takeModel = process.env.INVESTIGATOR_MODEL_TAKE ?? "gemini-3.5-flash";
  const deepModel = process.env.INVESTIGATOR_MODEL_DEEPDIVE ?? "gemini-3.5-flash";
  const maxTurnsTake = Number(process.env.MAX_TURNS_TAKE ?? 6);
  const maxTurnsDeep = Number(process.env.MAX_TURNS_DEEPDIVE ?? 14);

  const pg = new PgClient({ connectionString: dbUrl });
  await pg.connect();
  const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

  try {
    const code = opts.stockCode.toUpperCase();
    const assignment: Assignment = {
      stockCode: code,
      industry: null,
      angle: opts.angle ?? `What ${code}'s short position and recent events reveal`,
      tier: opts.tier,
      rationale: "preview",
    };
    const investigatorModel = opts.tier === "deep_dive" ? deepModel : takeModel;
    console.error(`[preview] investigating ${code} [${opts.tier}] (model ${investigatorModel})...`);
    const t0 = Date.now();
    const ledger = new CitationLedger();
    const dossier = await investigate(makeGeminiGenerate(ai, investigatorModel), pg, assignment, ledger, {
      maxTurns: opts.tier === "deep_dive" ? maxTurnsDeep : maxTurnsTake,
    });
    const overview = await getOverview(pg, code).catch(() => null);
    const take = await synthesiseFromDossier(dossier, ledger, code, overview);
    const hold = shouldHoldAsDraft(take);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    const line = "=".repeat(72);
    console.log("\n" + line);
    console.log(`PREVIEW — ${code} [${take.tier}]   (NOT inserted, no images)   ${secs}s`);
    console.log(line);
    console.log(`\nHEADLINE:  ${take.headline}`);
    console.log(`SENTIMENT: ${take.sentiment}     SLUG: ${take.slug}`);
    console.log(`GROUNDING: ${take.citations.length} citations, ${take.droppedCitations.length} dropped${take.droppedCitations.length ? ` (${take.droppedCitations.join(", ")})` : ""}`);
    console.log(`DECISION:  ${hold ? "HOLD as draft (weak grounding)" : "would auto-publish"}`);

    console.log(`\n--- DOSSIER ---`);
    console.log(`summary: ${dossier.summary}`);
    if (overview) console.log(`overview: short ${overview.currentShortPct?.toFixed(2)}% (Δ90d ${overview.shortPctChange90d?.toFixed(2)}), price 3m ${overview.priceChange3m?.toFixed(1)}%, corr ${overview.priceShortsCorrelation30d?.toFixed(2)}, peer ${overview.peerRelative}`);
    if (dossier.threads.length) {
      console.log(`threads:`);
      for (const th of dossier.threads) console.log(`  - ${th.claim} [${th.evidenceRefIds.join(", ")}]${th.note ? ` — ${th.note}` : ""}`);
    }
    if (dossier.timeline?.length) {
      console.log(`timeline:`);
      for (const tl of dossier.timeline) console.log(`  - ${tl.date}: ${tl.event} (${tl.refIds.join(", ")})`);
    }
    if (dossier.keyNumbers.length) {
      console.log(`keyNumbers:`);
      for (const kn of dossier.keyNumbers) console.log(`  - ${kn.label}: ${kn.value}${kn.refId ? ` [${kn.refId}]` : ""}`);
    }

    console.log(`\n--- BODY (markdown) ---\n`);
    console.log(take.bodyMd);

    console.log(`\n--- SOURCES (${take.citations.length}) ---`);
    for (const c of take.citations) console.log(`  [${c.refId}] (${c.type}) ${c.headline} — ${c.source} ${c.date}\n        ${c.url}`);
    console.log("");
  } finally {
    await pg.end();
  }
}

export async function regenerateImages(opts: { slug: string; inlineCount?: number }): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

  const pg = new PgClient({ connectionString: dbUrl });
  await pg.connect();
  const openai = new OpenAI({ apiKey: key });
  const storage = new Storage();
  const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  try {
    const { rows } = await pg.query<{ slug: string; headline: string; stock_code: string; body_md: string }>(
      `SELECT slug, headline, stock_code, body_md FROM editorial_takes WHERE slug = $1`,
      [opts.slug],
    );
    const row = rows[0];
    if (!row) throw new Error(`no editorial_takes row with slug ${opts.slug}`);

    const { rows: metaRows } = await pg.query<{ industry: string | null; summary: string | null }>(
      `SELECT industry, summary FROM "company-metadata" WHERE stock_code = $1`,
      [row.stock_code],
    );
    const industry = metaRows[0]?.industry ?? null;
    const summary = metaRows[0]?.summary ?? null;

    const candidate = { stockCode: row.stock_code, industry } as unknown as AgendaCandidate;
    const take = { slug: row.slug, headline: row.headline } as unknown as NarrativeTake;
    const count = opts.inlineCount ?? 2;

    console.error(`[regen-images] ${row.stock_code} "${row.headline}" — hero + ${count} inline + art-directed layout…`);
    const hero = await generateHero(openai, storage, candidate, take);
    const inl = await generateInlineImages(openai, storage, ai, candidate, take, row.body_md, count);

    // Art-director stage: a varied, content-grounded image plan stored as
    // layout_images (the frontend prefers this over the legacy inline_images).
    const artCtx: ArtContext = {
      stockCode: row.stock_code,
      headline: row.headline,
      industry,
      description: summary,
      bodyMd: row.body_md,
    };
    let layoutImages: LayoutImage[] = [];
    try {
      const plan = await designImagePlan(ai, artCtx, 3);
      console.error(`[regen-images] art-director planned ${plan.length} image(s): ${plan.map((p) => `${p.style}/${p.ratio}`).join(", ") || "(none)"}`);
      const gen = await generatePlanImages(openai, storage, opts.slug, plan);
      layoutImages = gen.images;
    } catch (err) {
      console.warn(`[regen-images] art-director stage failed: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }

    await pg.query(
      `UPDATE editorial_takes SET hero_image_url = $1, inline_images = $2::jsonb, layout_images = $3::jsonb, updated_at = NOW() WHERE slug = $4`,
      [hero.url, JSON.stringify(inl.images), JSON.stringify(layoutImages), opts.slug],
    );
    console.error(`[regen-images] done — hero + ${inl.images.length} inline + ${layoutImages.length} layout, ~$${(hero.costUsd + inl.costUsd).toFixed(3)}`);
    console.error(`hero: ${hero.url}`);
    for (const im of inl.images) console.error(`inline: ${im.url}`);
    for (const im of layoutImages) console.error(`layout [${im.style}/${im.ratio}/${im.placement}@${im.anchorAfterBlock}]: ${im.url}`);
    console.error(`Public: https://shorted.com.au/news/${opts.slug}`);
  } finally {
    await pg.end();
  }
}

export async function runNewsroom(opts: NewsroomOptions): Promise<NewsroomResult[]> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const pg = new PgClient({ connectionString: dbUrl });
  await pg.connect();

  let openai: OpenAI | null = null;
  let storage: Storage | null = null;
  let ai: GoogleGenerativeAI | null = null;
  if (opts.withImages) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not set (required for --with-images)");
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set (required for --with-images)");
    openai = new OpenAI({ apiKey: key });
    storage = new Storage();
    ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }

  const results: NewsroomResult[] = [];

  try {
    console.log(`\n[newsroom] building editorial agenda (top ${opts.topN} of pool ${opts.poolSize ?? 30})…`);
    const candidates = await buildAgenda(pg, {
      poolSize: opts.poolSize,
      topN: opts.topN,
      minScore: opts.minScore,
    });
    if (candidates.length === 0) {
      console.log("[newsroom] nothing newsworthy today.");
      return results;
    }

    console.log("");
    console.log(`[newsroom] ${candidates.length} pick(s) to write:`);
    for (const [i, c] of candidates.entries()) {
      console.log(`  ${i + 1}. ${c.stockCode} (score ${c.score}, ${c.angle}) — ${c.name}`);
    }
    console.log("");

    for (const [i, c] of candidates.entries()) {
      const t0 = Date.now();
      let costUsd = 0;
      const tag = `[${i + 1}/${candidates.length}]`;
      console.log(`\n${tag} ${c.stockCode}: ${c.name}`);
      console.log(`${tag}   angle=${c.angle}  score=${c.score}`);
      try {
        console.log(`${tag}   synthesising narrative…`);
        const take = await synthesiseNarrative(c.report);
        costUsd += 0.003; // rough Gemini Flash per Take
        const bodyMd = narrativeToBodyMd(take);
        console.log(`${tag}   → "${take.headline}"`);
        console.log(`${tag}   ${bodyMd.split(/\s+/).filter(Boolean).length} words, ${take.citations.length} citations`);

        let heroUrl: string | null = null;
        let inlineImages: InlineImageRow[] = [];
        if (opts.withImages && openai && storage && ai) {
          console.log(`${tag}   generating hero image (~30s, ~$0.075)…`);
          const img = await generateHero(openai, storage, c, take);
          heroUrl = img.url;
          costUsd += img.costUsd;

          console.log(`${tag}   generating 2 inline images (~60s, ~$0.15)…`);
          const inlines = await generateInlineImages(openai, storage, ai, c, take, bodyMd, 2);
          inlineImages = inlines.images;
          costUsd += inlines.costUsd;
        }

        await insertTake(pg, c, take, bodyMd, heroUrl, inlineImages, opts.autoPublish);

        const status: NewsroomResult["status"] = opts.autoPublish ? "published" : "drafted";
        results.push({
          stockCode: c.stockCode,
          score: c.score,
          angle: c.angle,
          slug: take.slug,
          headline: take.headline,
          heroUrl: heroUrl ?? undefined,
          status,
          costUsd,
          ms: Date.now() - t0,
        });
        console.log(`${tag}   ✓ ${status} as /news/${take.slug}  ($${costUsd.toFixed(3)}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        console.log(`${tag}   ✗ failed: ${msg.slice(0, 150)}`);
        results.push({
          stockCode: c.stockCode,
          score: c.score,
          angle: c.angle,
          status: "failed",
          error: msg.slice(0, 200),
          costUsd,
          ms: Date.now() - t0,
        });
      }
    }
  } finally {
    await pg.end();
  }

  // Briefing.
  console.log("");
  console.log("=== Newsroom briefing ===");
  const totalCost = results.reduce((a, r) => a + r.costUsd, 0);
  const drafted = results.filter((r) => r.status === "drafted").length;
  const published = results.filter((r) => r.status === "published").length;
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(`  drafted:   ${drafted}`);
  console.log(`  published: ${published}`);
  console.log(`  failed:    ${failed}`);
  console.log(`  total cost: $${totalCost.toFixed(3)}`);
  console.log("");
  for (const r of results) {
    if (r.status === "failed") {
      console.log(`  ✗ ${r.stockCode}: ${r.error}`);
    } else {
      console.log(`  ${r.status === "published" ? "📰" : "📝"} ${r.stockCode}: ${SITE_URL}/admin/takes/${r.slug}`);
    }
  }
  return results;
}
