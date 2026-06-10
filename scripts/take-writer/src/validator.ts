// Multimodal article-cohesion validator with an auto-fix loop.
//
// `validate-article --slug=X`:
//  1. Screenshot the rendered live page with Playwright (headless, full-page).
//  2. Judge with Gemini vision: full-page screenshot + the hero PNG + each
//     layout image PNG + the article text → structured cohesion verdict +
//     a hero verdict + per-image verdicts. The hero is judged as a masthead
//     lead image (concrete, editorial, photojournalistic).
//  3. Auto-fix loop: re-generate any image flagged `regenerate` with the
//     judge's corrected brief/caption (a flagged hero is re-shot as a
//     corrected-brief documentary landscape at high quality straight to
//     takes/{slug}-hero.png + hero_image_url), update the DB, and
//     re-judge the NEW image buffers (NOT a fresh screenshot — the live page
//     is ISR-cached up to 10 min, so only the image content changed).
//  4. Report the cohesion score, layout notes, and what was regenerated.

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import OpenAI from "openai";
import { Storage } from "@google-cloud/storage";
import { Client as PgClient } from "pg";
import { type LayoutImage, type PlanItem, generateOneLayoutImage, generatePlanHero } from "./art-director.js";

// gemini-3-pro-preview 404s on the generativelanguage v1beta API as of
// 2026-05-30; gemini-3.5-flash supports vision + responseSchema and is the
// working default. Override via VALIDATOR_MODEL when the preview model lands.
const JUDGE_MODEL = (): string => process.env.VALIDATOR_MODEL ?? "gemini-3.5-flash";
const SITE = (): string => process.env.SHORTED_SITE_URL ?? "https://shorted.com.au";

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

async function fetchPng(url: string): Promise<Buffer> {
  const r = await fetch(url);
  return Buffer.from(await r.arrayBuffer());
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
        qualityOk: { type: SchemaType.BOOLEAN, description: "no garbled/text/charts/faces/logos; concrete, editorial, photojournalistic" },
        issue: { type: SchemaType.STRING, description: "what's wrong, empty if fine" },
        regenerate: { type: SchemaType.BOOLEAN, description: "true if the hero should be regenerated" },
        newBrief: { type: SchemaType.STRING, description: "if regenerate: a corrected concrete documentary-landscape brief (no text/charts/faces)" },
        newCaption: { type: SchemaType.STRING, description: "if regenerate: a corrected news caption (what/where), else echo the existing caption" },
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
          qualityOk: { type: SchemaType.BOOLEAN, description: "no garbled/text/charts/faces/logos; on-tone; not abstract-when-it-should-be-concrete" },
          issue: { type: SchemaType.STRING, description: "what's wrong, empty if fine" },
          regenerate: { type: SchemaType.BOOLEAN, description: "true if this image should be regenerated" },
          newBrief: { type: SchemaType.STRING, description: "if regenerate: a corrected concrete image brief (no text/charts/faces)" },
          newCaption: { type: SchemaType.STRING, description: "if regenerate: a corrected caption, else echo the existing caption" },
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
): Promise<CohesionVerdict> {
  const model = ai.getGenerativeModel({
    model: JUDGE_MODEL(),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: VERDICT_SCHEMA,
      temperature: 0.3,
      ...({ thinkingConfig: { thinkingBudget: 0 } } as unknown as Record<string, unknown>),
    } as unknown as Parameters<GoogleGenerativeAI["getGenerativeModel"]>[0]["generationConfig"],
  });
  const common =
    `You are the editor reviewing whether this published article LOOKS GOOD and is cohesive. Headline: "${headline}".\n\n` +
    `Body (markdown):\n${bodyMd.slice(0, 4000)}\n\n` +
    (hero ? `Hero caption: "${hero.caption ?? "(none)"}"\n\n` : "") +
    `Layout images (index: caption | placement | ratio):\n` +
    `${layoutImages.map((li, i) => `${i}: "${li.caption}" | ${li.placement} | ${li.ratio}`).join("\n")}\n\n`;
  const heroRule = hero
    ? `HERO: the first individual image${screenshot ? " after the screenshot" : ""} is the HERO — the page-top masthead lead image. Does it read as a credible masthead lead image for this story (concrete, editorial, photojournalistic)? Score it like any other image and return the "hero" verdict object; if it is abstract, generic, garbled, or off-story, set hero.regenerate=true with a corrected documentary-landscape newBrief + a proper news newCaption (what/where). `
    : `No hero image is provided — omit the "hero" verdict object. `;
  const tail =
    heroRule +
    `Flag regenerate=true ONLY for a body layout image that is off-topic, garbled, generic-when-it-should-be-specific, contains text/charts/faces/logos, ` +
    `or whose caption doesn't match. Give a corrected newBrief + newCaption for any flagged image.`;
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
  const resp = await model.generateContent(parts as unknown as Parameters<ReturnType<GoogleGenerativeAI["getGenerativeModel"]>["generateContent"]>[0]);
  return JSON.parse(resp.response.text()) as CohesionVerdict;
}

export async function validateArticle(slug: string, opts: { rounds?: number } = {}): Promise<void> {
  const maxRounds = opts.rounds ?? 2;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const pg = new PgClient({ connectionString: dbUrl });
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
    if (!layout.length && !heroUrl) {
      console.log("[validate] no hero_image_url or layout_images on this take");
      return;
    }
    const headline = row.headline;
    const bodyMd = row.body_md;

    console.error(`[validate] screenshotting ${slug}…`);
    const shot = await screenshotArticle(slug);
    console.error("[validate] mode: " + (shot ? "screenshot+per-image" : "per-image only"));
    const imageBufs = await Promise.all(layout.map((li) => fetchPng(li.url)));
    let heroBuf: Buffer | null = heroUrl ? await fetchPng(heroUrl).catch(() => null) : null;

    for (let round = 1; round <= maxRounds; round++) {
      console.error(`[validate] round ${round}: judging (model ${JUDGE_MODEL()})…`);
      const v = await judge(ai, headline, bodyMd, layout, shot, imageBufs, heroBuf ? { buf: heroBuf, caption: heroCaption } : null);
      console.log(`\n=== cohesion ${v.cohesionScore}/10 — ${v.verdict} ===`);
      console.log(`layout: ${v.layoutNotes}`);
      if (heroBuf && v.hero) {
        console.log(`  [hero ] fit=${v.hero.fits} caption=${v.hero.captionAccurate} quality=${v.hero.qualityOk} regen=${v.hero.regenerate} — ${v.hero.issue || "ok"}`);
      }
      for (const iv of v.images) {
        console.log(`  [img ${iv.index}] fit=${iv.fits} caption=${iv.captionAccurate} quality=${iv.qualityOk} regen=${iv.regenerate} — ${iv.issue || "ok"}`);
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
        // Re-shoot the hero as a corrected-brief documentary landscape at the
        // canonical takes/{slug}-hero.png path (high quality) — same route the
        // art-director's hero takes, so the brand-fallback case upgrades too.
        const spec: PlanItem = {
          role: "hero",
          style: "documentary",
          ratio: "landscape",
          brief: v.hero.newBrief || `${headline} — the story's central real-world subject`,
          caption: v.hero.newCaption || heroCaption || headline,
          placement: "full",
          anchorAfterBlock: 0,
        };
        console.error(`[validate] regenerating hero: ${v.hero.issue}`);
        const regen = await generatePlanHero(openai, storage, slug, spec);
        heroUrl = regen.image.url;
        heroCaption = spec.caption;
        await pg.query(
          `UPDATE editorial_takes SET hero_image_url=$1, hero_caption=$2, hero_credit=COALESCE(hero_credit, 'AI-generated illustration'), updated_at=NOW() WHERE slug=$3`,
          [heroUrl, heroCaption, slug],
        );
        // Cache-bust so the re-judge sees the NEW hero.
        heroBuf = await fetchPng(`${heroUrl}?t=${round}`);
      }
      for (const iv of toFix) {
        const old = layout[iv.index]!;
        const spec: PlanItem = { ...old, brief: iv.newBrief || old.brief, caption: iv.newCaption || old.caption };
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
