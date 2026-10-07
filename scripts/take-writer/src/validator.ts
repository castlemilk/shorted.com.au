// Multimodal article-cohesion validator with an auto-fix loop.
//
// `validate-article --slug=X`:
//  1. Screenshot the rendered live page with Playwright (headless, full-page).
//  2. Judge with Gemini vision: full-page screenshot + the hero PNG + each
//     layout image PNG + the article text → structured cohesion verdict +
//     a hero verdict + per-image verdicts. The hero is judged as a masthead
//     lead image (concrete, editorial, clearly illustrative).
//  3. Auto-fix loop: re-generate any image flagged `regenerate` with the
//     judge's corrected brief/caption (a flagged hero is re-shot as a
//     corrected-brief paper-collage landscape at high quality straight to
//     takes/{slug}-hero.png + hero_image_url), update the DB, and
//     re-judge the NEW image buffers (NOT a fresh screenshot — the live page
//     is ISR-cached up to 10 min, so only the image content changed).
//  4. Report the cohesion score, layout notes, and what was regenerated.

import { createHash } from "node:crypto";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import OpenAI from "openai";
import { Storage } from "@google-cloud/storage";
import { Client as PgClient } from "pg";
import { z } from "zod";
import { type LayoutImage, type PlanItem, generateOneLayoutImage, generatePlanHero } from "./art-director.js";
import { illustrationCaption } from "./illustration-caption.js";
import { EDITORIAL_REVIEW_RULES } from "./editorial-art-policy.js";

// gemini-3-pro-preview 404s on the generativelanguage v1beta API as of
// 2026-05-30; gemini-3.5-flash supports vision + responseSchema and is the
// working default. Override via VALIDATOR_MODEL when the preview model lands.
const JUDGE_MODEL = (): string => process.env.VALIDATOR_MODEL ?? "gemini-3.5-flash";
const SITE = (): string => process.env.SHORTED_SITE_URL ?? "https://shorted.com.au";

/** Publication is one bounded review; interactive validate-article may still auto-fix. */
export const PUBLICATION_VISION_LIMITS = Object.freeze({
  model: "gemini-3.5-flash",
  rounds: 1,
  candidateCount: 1,
  maxInputTokens: 12_000,
  maxOutputTokens: 8_192,
  minCohesionScore: 7,
  requestTimeoutMs: 120_000,
  imageTimeoutMs: 30_000,
  maxImageBytes: 8 * 1024 * 1024,
});

async function screenshotArticle(slug: string): Promise<Buffer | null> {
  if (process.env.VALIDATOR_SCREENSHOT === "0") return null;
  // Playwright is an optional, browser-bearing dependency. In a lean
  // serverless container (no chromium binary) the dynamic import or
  // launch fails — degrade to per-image-only judging instead of crashing.
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("[validate] playwright not installed — skipping full-page screenshot, judging per-image only");
    return null;
  }
  let browser: import("playwright").Browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.error(`[validate] chromium launch failed (${String((e as Error).message ?? e).slice(0, 80)}) — skipping screenshot, per-image only`);
    return null;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(`${SITE()}/news/${slug}`, { waitUntil: "networkidle", timeout: 45000 });
    // Trigger lazy images: scroll through the page, then return to top.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    return await page.screenshot({ fullPage: true, type: "png" });
  } finally {
    await browser.close();
  }
}

async function fetchPng(url: string, required = false): Promise<Buffer> {
  if (required && new URL(url).protocol !== "https:") throw new Error("publication images require an absolute HTTPS URL");
  const r = await fetch(url, required ? { signal: AbortSignal.timeout(PUBLICATION_VISION_LIMITS.imageTimeoutMs) } : undefined);
  if (!required) return Buffer.from(await r.arrayBuffer());
  if (!r.ok || !/^image\/png(?:;|$)/i.test(r.headers.get("content-type") ?? "")) {
    throw new Error("publication image fetch did not return a successful PNG response");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (!r.body) throw new Error("publication image response is empty");
  for await (const chunk of r.body) {
    bytes += chunk.length;
    if (bytes > PUBLICATION_VISION_LIMITS.maxImageBytes) throw new Error("publication image exceeds the byte limit");
    chunks.push(chunk);
  }
  const png = Buffer.concat(chunks);
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.readUInt32BE(16) === 0 || png.readUInt32BE(20) === 0) {
    throw new Error("publication image is not a valid PNG header");
  }
  return png;
}

interface ImageVerdict {
  index: number;
  fits: boolean;
  captionAccurate: boolean;
  qualityOk: boolean;
  issue: string;
  regenerate: boolean;
  newBrief: string;
  newCaption: string;
}

interface HeroVerdict {
  fits: boolean;
  captionAccurate: boolean;
  qualityOk: boolean;
  issue: string;
  regenerate: boolean;
  newBrief: string;
  newCaption: string;
}

interface CohesionVerdict {
  cohesionScore: number;
  layoutNotes: string;
  verdict: string;
  hero?: HeroVerdict;
  images: ImageVerdict[];
}

const IMAGE_RESULT = z.object({
  fits: z.boolean(), captionAccurate: z.boolean(), qualityOk: z.boolean(),
  issue: z.string(), regenerate: z.boolean(), newBrief: z.string(), newCaption: z.string(),
});
const PUBLICATION_VERDICT = z.object({
  cohesionScore: z.number().min(0).max(10), layoutNotes: z.string(), verdict: z.string().trim().min(1),
  hero: IMAGE_RESULT,
  images: z.array(IMAGE_RESULT.extend({ index: z.number().int().nonnegative() })),
});

function requirePublicationVerdict(value: unknown, imageCount: number): CohesionVerdict {
  const parsed = PUBLICATION_VERDICT.safeParse(value);
  if (!parsed.success) {
    // Schema paths contain only our known field names and array indices.
    // Never log model text, captions, briefs, image bytes or SDK error payloads.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].slice(0, 20);
    const codes = [...new Set(parsed.error.issues.map((issue) => issue.code))];
    console.error(`[validate] publication rejection=${JSON.stringify({ reason: "invalid_schema", fields, codes })}`);
    throw new Error("publication vision verdict does not match the required schema");
  }
  const verdict = parsed.data;
  const indices = new Set(verdict.images.map((v) => v.index));
  if (verdict.images.length !== imageCount || indices.size !== imageCount || verdict.images.some((v) => v.index >= imageCount)) {
    console.error(`[validate] publication rejection=${JSON.stringify({ reason: "incomplete_image_coverage", expected: imageCount, actual: verdict.images.length, unique: indices.size })}`);
    throw new Error("publication verdict does not cover every layout image exactly once");
  }
  if (verdict.cohesionScore < PUBLICATION_VISION_LIMITS.minCohesionScore || [verdict.hero, ...verdict.images].some((v) => !v.fits || !v.captionAccurate || !v.qualityOk || v.regenerate || v.issue.trim())) {
    const flags = (v: HeroVerdict) => ({ fits: v.fits, captionAccurate: v.captionAccurate, qualityOk: v.qualityOk, regenerate: v.regenerate, issuePresent: Boolean(v.issue.trim()) });
    console.error(`[validate] publication rejection=${JSON.stringify({ reason: "image_review_failed", cohesionScore: verdict.cohesionScore, minimum: PUBLICATION_VISION_LIMITS.minCohesionScore, hero: flags(verdict.hero), images: verdict.images.map((v) => ({ index: v.index, ...flags(v) })) })}`);
    // Keep #685's readable failure names for its cause-chain logger, while
    // retaining only controlled checks rather than model-authored issue text.
    const failures: string[] = [];
    if (verdict.cohesionScore < PUBLICATION_VISION_LIMITS.minCohesionScore) {
      failures.push(`cohesion ${verdict.cohesionScore}/10 below ${PUBLICATION_VISION_LIMITS.minCohesionScore}`);
    }
    for (const [label, v] of [["hero", verdict.hero], ...verdict.images.map((v) => [`img ${v.index}`, v] as const)] as const) {
      const failed = [!v.fits && "fit", !v.captionAccurate && "caption", !v.qualityOk && "quality", v.regenerate && "regenerate"].filter(Boolean);
      if (failed.length || v.issue.trim()) failures.push(`${label}: ${failed.join(",") || "issue"}`);
    }
    throw new Error(`vision review found image issues; article stays draft for review: ${failures.join("; ")}`);
  }
  return verdict;
}

const VERDICT_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    cohesionScore: { type: SchemaType.NUMBER, description: "0-10: how cohesive and well-stitched the overall article looks" },
    layoutNotes: { type: SchemaType.STRING, description: "Notes on the page layout/flow/balance from the screenshot" },
    verdict: { type: SchemaType.STRING, description: "One-line overall assessment" },
    hero: {
      type: SchemaType.OBJECT,
      description: "Verdict on the HERO image (only when a hero image was provided)",
      properties: {
        fits: { type: SchemaType.BOOLEAN, description: "does the hero read as a credible masthead lead image for this story" },
        captionAccurate: { type: SchemaType.BOOLEAN },
        qualityOk: { type: SchemaType.BOOLEAN, description: "coherent construction, perspective, joins and shadows; no fused/duplicated parts, generic template polish, garbled/text/charts/faces/logos; concrete action legible at thumbnail size" },
        issue: { type: SchemaType.STRING, description: "what's wrong, empty if fine" },
        regenerate: { type: SchemaType.BOOLEAN, description: "true if the hero should be regenerated" },
        newBrief: { type: SchemaType.STRING, description: "if regenerate: a corrected conceptual paper-collage landscape brief with one concrete subject/action; no text/charts/faces or fake photojournalism of real places/events" },
        newCaption: { type: SchemaType.STRING, description: "if regenerate: <=12 words beginning 'Illustration:' describing the conceptual subject/action without a claim of actual photographed place/event, else echo the existing caption" },
      },
      required: ["fits", "captionAccurate", "qualityOk", "issue", "regenerate", "newBrief", "newCaption"],
    },
    images: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          index: { type: SchemaType.NUMBER },
          fits: { type: SchemaType.BOOLEAN, description: "does the image illustrate the section/caption it accompanies" },
          captionAccurate: { type: SchemaType.BOOLEAN },
          qualityOk: { type: SchemaType.BOOLEAN, description: "coherent construction and readable action; no fused/duplicated parts, generic template polish, garbled/text/charts/faces/logos; on-tone and specific to the section" },
          issue: { type: SchemaType.STRING, description: "what's wrong, empty if fine" },
          regenerate: { type: SchemaType.BOOLEAN, description: "true if this image should be regenerated" },
          newBrief: { type: SchemaType.STRING, description: "if regenerate: a corrected concrete image brief (no text/charts/faces)" },
          newCaption: { type: SchemaType.STRING, description: "if regenerate: a corrected conceptual caption beginning 'Illustration:', never a claim of real photographed place/event, else echo the existing caption" },
        },
        required: ["index", "fits", "captionAccurate", "qualityOk", "issue", "regenerate", "newBrief", "newCaption"],
      },
    },
  },
  required: ["cohesionScore", "layoutNotes", "verdict", "images"],
};

async function judge(
  ai: GoogleGenerativeAI,
  headline: string,
  bodyMd: string,
  layoutImages: LayoutImage[],
  screenshot: Buffer | null,
  imageBufs: Buffer[],
  hero: { buf: Buffer; caption: string | null } | null,
  requirePass = false,
): Promise<CohesionVerdict> {
  const model = ai.getGenerativeModel({
    model: requirePass ? PUBLICATION_VISION_LIMITS.model : JUDGE_MODEL(),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: requirePass ? { ...VERDICT_SCHEMA, required: [...VERDICT_SCHEMA.required, "hero"] } : VERDICT_SCHEMA,
      temperature: 0.3,
      ...(requirePass ? { candidateCount: PUBLICATION_VISION_LIMITS.candidateCount, maxOutputTokens: PUBLICATION_VISION_LIMITS.maxOutputTokens } : {}),
      ...({ thinkingConfig: { thinkingBudget: 0 } } as unknown as Record<string, unknown>),
    } as unknown as Parameters<GoogleGenerativeAI["getGenerativeModel"]>[0]["generationConfig"],
  }, requirePass ? { timeout: PUBLICATION_VISION_LIMITS.requestTimeoutMs } : undefined);
  const common =
    `You are the editor reviewing whether this published article LOOKS GOOD and is cohesive. Headline: "${headline}".\n\n` +
    `Body (markdown):\n${bodyMd.slice(0, 4000)}\n\n` +
    (hero ? `Hero caption: "${hero.caption ?? "(none)"}"\n\n` : "") +
    `Layout images (index: caption | placement | ratio):\n` +
    `${layoutImages.map((li, i) => `${i}: "${li.caption}" | ${li.placement} | ${li.ratio}`).join("\n")}\n\n` +
    `${EDITORIAL_REVIEW_RULES}\n\n`;
  const heroRule = hero
    ? `HERO: the first individual image${screenshot ? " after the screenshot" : ""} is the HERO, the page-top masthead illustration. Does its recognisable concrete subject and visual action communicate THIS article's finding or mechanism at thumbnail size? Paper collage, printmaking and sculptural still life are preferred; light and dark grounds both belong to Shorted. Conceptual metaphor is valid when specific to the story and preserving uncertainty. Return the "hero" verdict object; regenerate ONLY for a concrete craft defect from the review criteria, generic/garbled/off-story/misleading imagery, or pretending to document a real place/event. Supply a corrected conceptual paper-collage landscape newBrief and a <=12-word newCaption beginning 'Illustration:'. Do not replace a valid illustration merely because it is not photographic. `
    : `No hero image is provided — omit the "hero" verdict object. `;
  const tail =
    heroRule +
    `Flag regenerate=true ONLY for a body layout image with a concrete craft defect from the review criteria, that is off-topic, garbled, generic-when-it-should-be-specific, contains text/charts/faces/logos, ` +
    `or whose caption doesn't match or claims a fabricated photograph of a real place/event. Light or dark tactile illustration is valid; metaphors must preserve uncertainty and exact measured data stays outside the artwork. Give a corrected conceptual newBrief + newCaption beginning 'Illustration:' for any flagged image.`;
  const promptText = screenshot
    ? common +
      `First image below = the FULL-PAGE SCREENSHOT of the rendered article (judge layout/flow/balance). ` +
      `The remaining images = ${hero ? "the HERO image, then " : ""}the individual layout images in order (judge each against its caption + the section it illustrates). ` +
      `Judge cohesion on the hero + body layout images and the overall layout/flow. ` +
      tail
    : common +
      `The images below are ${hero ? "the HERO image, then " : ""}the article's layout images in order. No full-page render is available, so judge per-image fit/caption/quality and infer overall cohesion from the captions + body. ` +
      tail;
  const parts: Array<Record<string, unknown>> = [{ text: promptText }];
  if (screenshot) parts.push({ inlineData: { mimeType: "image/png", data: screenshot.toString("base64") } });
  if (hero) parts.push({ inlineData: { mimeType: "image/png", data: hero.buf.toString("base64") } });
  for (const b of imageBufs) parts.push({ inlineData: { mimeType: "image/png", data: b.toString("base64") } });
  const input = parts as unknown as Parameters<ReturnType<GoogleGenerativeAI["getGenerativeModel"]>["generateContent"]>[0];
  if (requirePass) {
    const { totalTokens } = await model.countTokens(input);
    if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0 || totalTokens > PUBLICATION_VISION_LIMITS.maxInputTokens) {
      throw new Error("publication vision input exceeds its token limit or token count is unavailable");
    }
    console.log(`[validate] input tokens=${totalTokens}; output limit=${PUBLICATION_VISION_LIMITS.maxOutputTokens}; inference attempts=1`);
  }
  const resp = await model.generateContent(input);
  if (requirePass) {
    const candidates = resp.response.candidates;
    if (candidates?.length !== 1 || candidates[0]?.finishReason !== "STOP") {
      throw new Error("publication vision response is blocked, truncated or incomplete");
    }
    const usage = resp.response.usageMetadata;
    const counts = [usage?.promptTokenCount, usage?.candidatesTokenCount, usage?.totalTokenCount];
    if (!counts.every((v) => Number.isSafeInteger(v) && v! >= 0) || !usage) {
      throw new Error("publication vision usage counters are unavailable");
    }
    const outputAndThinking = usage.totalTokenCount - usage.promptTokenCount;
    console.log(`[validate] usage input=${usage.promptTokenCount} visible output=${usage.candidatesTokenCount} output+thinking=${outputAndThinking} total=${usage.totalTokenCount}`);
    if (usage.promptTokenCount > PUBLICATION_VISION_LIMITS.maxInputTokens || outputAndThinking < usage.candidatesTokenCount || outputAndThinking > PUBLICATION_VISION_LIMITS.maxOutputTokens) {
      throw new Error("publication vision reported usage outside its token limits");
    }
    let responseText: string;
    try {
      responseText = resp.response.text();
    } catch {
      console.error('[validate] publication rejection={"reason":"response_text_unavailable"}');
      throw new Error("publication vision response text is unavailable");
    }
    // Retain correlation metadata, never the response payload or SDK error.
    console.error(`[validate] publication response=${JSON.stringify({
      candidateCount: candidates.length, finishReason: candidates[0]!.finishReason,
      textBytes: Buffer.byteLength(responseText),
      textSha256: createHash("sha256").update(responseText).digest("hex"),
    })}`);
    let verdict: unknown;
    try {
      verdict = JSON.parse(responseText);
    } catch {
      console.error('[validate] publication rejection={"reason":"invalid_json"}');
      throw new Error("publication vision returned invalid JSON");
    }
    return requirePublicationVerdict(verdict, layoutImages.length);
  }
  return JSON.parse(resp.response.text()) as CohesionVerdict;
}

export async function validateArticle(slug: string, opts: { rounds?: number; requirePass?: boolean } = {}): Promise<void> {
  const requirePass = opts.requirePass === true;
  if (requirePass && opts.rounds !== undefined && opts.rounds !== PUBLICATION_VISION_LIMITS.rounds) {
    throw new Error("publication vision requires exactly one round");
  }
  const maxRounds = requirePass ? PUBLICATION_VISION_LIMITS.rounds : opts.rounds ?? 2;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const pg = new PgClient({ connectionString: dbUrl, keepAlive: true, keepAliveInitialDelayMillis: 5_000 });
  if (typeof pg.on === "function") {
    pg.on("error", (err) => console.warn(`[pg] connection error: ${err.message}`));
  }
  await pg.connect();
  const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const storage = new Storage();
  try {
    const { rows } = await pg.query<{ headline: string; body_md: string; layout_images: LayoutImage[] | null; hero_image_url: string | null; hero_caption: string | null }>(
      `SELECT headline, body_md, layout_images, hero_image_url, hero_caption FROM editorial_takes WHERE slug=$1`,
      [slug],
    );
    const row = rows[0];
    if (!row) throw new Error(`no take ${slug}`);
    const layout: LayoutImage[] = row.layout_images ?? [];
    let heroUrl = row.hero_image_url;
    let heroCaption = row.hero_caption;
    if (requirePass && !heroUrl) throw new Error("publication requires an existing hero image");
    if (!layout.length && !heroUrl) {
      console.log("[validate] no hero_image_url or layout_images on this take");
      return;
    }
    const headline = row.headline;
    const bodyMd = row.body_md;

    console.error(`[validate] screenshotting ${slug}…`);
    const shot = requirePass ? null : await screenshotArticle(slug);
    console.error("[validate] mode: " + (shot ? "screenshot+per-image" : "per-image only"));
    const imageBufs = await Promise.all(layout.map((li) => fetchPng(li.url, requirePass)));
    let heroBuf: Buffer | null = heroUrl ? (requirePass ? await fetchPng(heroUrl, true) : await fetchPng(heroUrl).catch(() => null)) : null;

    for (let round = 1; round <= maxRounds; round++) {
      console.error(`[validate] round ${round}: judging (model ${requirePass ? PUBLICATION_VISION_LIMITS.model : JUDGE_MODEL()})…`);
      const v = await judge(ai, headline, bodyMd, layout, shot, imageBufs, heroBuf ? { buf: heroBuf, caption: heroCaption } : null, requirePass);
      if (requirePass) {
        console.log(`[validate] publication verdict accepted=${JSON.stringify({
          cohesionScore: v.cohesionScore, heroApproved: true, layoutImageCount: v.images.length,
        })}`);
      } else {
        console.log(`\n=== cohesion ${v.cohesionScore}/10 — ${v.verdict} ===`);
        console.log(`layout: ${v.layoutNotes}`);
        if (heroBuf && v.hero) {
          console.log(`  [hero ] fit=${v.hero.fits} caption=${v.hero.captionAccurate} quality=${v.hero.qualityOk} regen=${v.hero.regenerate} — ${v.hero.issue || "ok"}`);
        }
        for (const iv of v.images) {
          console.log(`  [img ${iv.index}] fit=${iv.fits} caption=${iv.captionAccurate} quality=${iv.qualityOk} regen=${iv.regenerate} — ${iv.issue || "ok"}`);
        }
      }
      const toFix = v.images.filter((iv) => iv.regenerate && iv.index >= 0 && iv.index < layout.length);
      const fixHero = Boolean(heroBuf && v.hero?.regenerate);
      if (!toFix.length && !fixHero) {
        console.log(`[validate] no fixes needed — article is cohesive.`);
        break;
      }
      if (round === maxRounds) {
        console.log(`[validate] ${toFix.length + (fixHero ? 1 : 0)} issue(s) remain after ${maxRounds} rounds — leaving for review.`);
        break;
      }
      if (fixHero && v.hero) {
        // Re-render the hero as a corrected-brief paper-collage landscape at the
        // canonical takes/{slug}-hero.png path (high quality) — same route the
        // art-director's hero takes, so the brand-fallback case upgrades too.
        const spec: PlanItem = {
          role: "hero",
          style: "paper_collage",
          ratio: "landscape",
          brief: v.hero.newBrief || `Conceptual illustration for ${headline}, one concrete subject performing the story's central mechanism`,
          caption: illustrationCaption(v.hero.newCaption || heroCaption),
          placement: "full",
          anchorAfterBlock: 0,
        };
        console.error(`[validate] regenerating hero: ${v.hero.issue}`);
        const regen = await generatePlanHero(openai, storage, slug, spec);
        heroUrl = regen.image.url;
        heroCaption = spec.caption;
        await pg.query(
          `UPDATE editorial_takes SET hero_image_url=$1, hero_caption=$2, hero_credit='AI-generated illustration', updated_at=NOW() WHERE slug=$3`,
          [heroUrl, heroCaption, slug],
        );
        // Cache-bust so the re-judge sees the NEW hero.
        heroBuf = await fetchPng(`${heroUrl}?t=${round}`);
      }
      for (const iv of toFix) {
        const old = layout[iv.index]!;
        const spec: PlanItem = { ...old, brief: iv.newBrief || old.brief, caption: illustrationCaption(iv.newCaption || old.caption) };
        console.error(`[validate] regenerating img ${iv.index} (${old.style}/${old.ratio}): ${iv.issue}`);
        const regenerated = await generateOneLayoutImage(openai, storage, slug, iv.index, spec);
        layout[iv.index] = regenerated;
        // Cache-bust the buffer fetch so the re-judge sees the NEW image.
        imageBufs[iv.index] = await fetchPng(regenerated.url + `?t=${round}`);
      }
      if (toFix.length) {
        await pg.query(`UPDATE editorial_takes SET layout_images=$1::jsonb, updated_at=NOW() WHERE slug=$2`, [JSON.stringify(layout), slug]);
      }
      console.error(`[validate] updated images; re-judging fixed images…`);
    }
    console.error(`Public: ${SITE()}/news/${slug}`);
  } finally {
    await pg.end();
  }
}
