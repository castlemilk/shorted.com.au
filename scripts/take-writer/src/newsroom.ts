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
  candidate: AgendaCandidate,
  take: NarrativeTake,
  count = 2,
): Promise<{ images: InlineImageRow[]; costUsd: number }> {
  // Inline images use treatments DIFFERENT from the hero (we ask
  // pickTreatments for count+1 and skip the first, which is the hero).
  // This guarantees the inline pictures don't visually echo the hero.
  const treatments = pickTreatments(take.slug, count + 1).slice(1);
  const subjectHint = subjectHintForIndustry(candidate.industry);

  // The two inline images riff on the two later narrative sections —
  // recent_events (which is "what happened") and the_data (which is
  // "what the numbers say"). We hint at that to keep them coherent
  // with the prose they sit next to.
  const sectionHints = [
    "supporting the 'recent events' section — gestures at the event the headline names without literally depicting it",
    "supporting the 'data' section — abstract, restrained, evoking weight or movement without showing any actual data, charts or numbers",
  ];

  const out: InlineImageRow[] = [];
  let totalCost = 0;
  for (let i = 0; i < count; i++) {
    const treatment = treatments[i] ?? treatments[0]!;
    const sectionHint = sectionHints[i] ?? sectionHints[0]!;
    const topic = `Inline editorial illustration #${i + 1} for an article about ASX: ${candidate.stockCode} (sector: ${candidate.industry ?? "general market"}). Headline: ${take.headline}.

Role: ${sectionHint}.
Subject vocabulary: ${subjectHint}.
Composition treatment: ${treatment.composition}.
Mood: ${treatment.mood}.

No text, no charts, no numbers, no people, no logos, no recognisable architecture.`;
    const prompt = `${BRAND_PROMPT}\n\n${topic}\n\nFormat: 16:9 horizontal banner composition, slightly less dramatic than a hero so it sits well inline.${FINAL_RULES}`;

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
        topic: treatment.name,
        alt: `Editorial illustration: ${treatment.mood}`,
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
  publish: boolean,
  writerModel: string,
): Promise<void> {
  const publishedClause = publish ? "NOW()" : "NULL";
  // ON CONFLICT preserves published_at: re-runs never silently flip a reviewed draft's publish state.
  await pg.query(
    `INSERT INTO editorial_takes (
       slug, headline, stock_code, body_md, sentiment, word_count, model, tier,
       citations, hero_image_url, inline_images, published_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,${publishedClause})
     ON CONFLICT (slug) DO UPDATE SET
       headline=EXCLUDED.headline, body_md=EXCLUDED.body_md, tier=EXCLUDED.tier,
       sentiment=EXCLUDED.sentiment, word_count=EXCLUDED.word_count,
       citations=EXCLUDED.citations,
       hero_image_url=COALESCE(EXCLUDED.hero_image_url, editorial_takes.hero_image_url),
       inline_images=CASE WHEN jsonb_array_length(EXCLUDED.inline_images) > 0
                          THEN EXCLUDED.inline_images ELSE editorial_takes.inline_images END,
       updated_at=NOW()`,
    [
      take.slug, take.headline, stockCode, take.bodyMd, take.sentiment,
      take.bodyMd.split(/\s+/).filter(Boolean).length, writerModel, take.tier,
      JSON.stringify(take.citations), heroUrl, JSON.stringify(inlineImages),
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
        const take = await synthesiseFromDossier(dossier, ledger, a.stockCode);
        console.log(`${tag} -> "${take.headline}" (${take.citations.length} cites, ${take.droppedCitations.length} dropped)`);

        const hold = shouldHoldAsDraft(take);
        if (hold) {
          console.warn(`${tag}   weak grounding (dropped ${take.droppedCitations.join(",") || "none"}; ${take.citations.length} cites) — held as draft`);
        }
        const publishThis = opts.autoPublish && !hold;

        let heroUrl: string | null = null;
        let inlineImages: InlineImageRow[] = [];
        if (opts.withImages && openai && storage) {
          const candidate = { stockCode: a.stockCode, industry: a.industry } as unknown as AgendaCandidate;
          const narrativeShim = { slug: take.slug, headline: take.headline } as unknown as NarrativeTake;
          const img = await generateHero(openai, storage, candidate, narrativeShim);
          heroUrl = img.url; totalCost += img.costUsd;
          const inl = await generateInlineImages(openai, storage, candidate, narrativeShim, 2);
          inlineImages = inl.images; totalCost += inl.costUsd;
        }

        await insertDossierTake(pg, take, a.stockCode, heroUrl, inlineImages, publishThis, writerModel);
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
    const take = await synthesiseFromDossier(dossier, ledger, code);
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

export async function runNewsroom(opts: NewsroomOptions): Promise<NewsroomResult[]> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const pg = new PgClient({ connectionString: dbUrl });
  await pg.connect();

  let openai: OpenAI | null = null;
  let storage: Storage | null = null;
  if (opts.withImages) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not set (required for --with-images)");
    openai = new OpenAI({ apiKey: key });
    storage = new Storage();
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
        if (opts.withImages && openai && storage) {
          console.log(`${tag}   generating hero image (~30s, ~$0.075)…`);
          const img = await generateHero(openai, storage, c, take);
          heroUrl = img.url;
          costUsd += img.costUsd;

          console.log(`${tag}   generating 2 inline images (~60s, ~$0.15)…`);
          const inlines = await generateInlineImages(openai, storage, c, take, 2);
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
