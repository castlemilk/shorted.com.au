// End-to-end orchestrator for an on-demand Shorted Take.
//
// run --stock=CODE [--headline=...] [--auto-publish] [--auto-tweet]
//
//   1. If no --headline given, picks the top news headline for the stock
//   2. Drafts the Take body + slug via Gemini
//   3. Generates hero (and optional thumbnail) via gpt-image-2 + GCS upload
//   4. INSERTs into editorial_takes (published_at NULL by default)
//   5. If --auto-publish: sets published_at = NOW()
//   6. If --auto-tweet: triggers process-publish-queue inline
//   7. Prints /admin/takes/<slug> for review and /news/<slug> for preview
//
// Designed for terminal use after `discover` surfaces candidates.

import { Client as PgClient } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import { Storage } from "@google-cloud/storage";
import { TAKE_SYSTEM_PROMPT, SLUG_PROMPT } from "./persona.js";

const API_URL = process.env.SHORTED_API_URL ?? "https://api.shorted.com.au";
const SITE_URL = process.env.SHORTED_SITE_URL ?? "https://shorted.com.au";
const GCS_BUCKET = process.env.GCS_LOGO_BUCKET ?? "shorted-company-logos";

interface RunOptions {
  stockCode: string;
  headline?: string;
  autoPublish: boolean;
  autoTweet: boolean;
}

interface NewsArticle {
  headline?: string;
  url?: string;
  source?: string;
  sentiment?: string;
  summary?: string;
  stockCode?: string;
  isPriceSensitive?: boolean;
}

interface TopShort {
  productCode: string;
  name: string;
  latestShortPosition?: number;
}

const BROWSER_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Origin: "https://shorted.com.au",
  Referer: "https://shorted.com.au/",
};

async function call<T>(endpoint: string, body: object): Promise<T> {
  for (let i = 1; i <= 4; i++) {
    const res = await fetch(
      `${API_URL}/shorts.v1alpha1.ShortedStocksService/${endpoint}`,
      { method: "POST", headers: BROWSER_HEADERS, body: JSON.stringify(body) },
    );
    if (res.ok) return (await res.json()) as T;
    if (res.status < 500 || i === 4) {
      throw new Error(`${endpoint} -> HTTP ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 800 * i));
  }
  throw new Error("unreachable");
}

async function pickHeadline(stockCode: string): Promise<{ headline: string; source: string | undefined; url: string | undefined } | null> {
  // Use market-wide news, filter to headlines mentioning the stock.
  const resp = await call<{ articles?: NewsArticle[] }>("GetMarketNews", {
    limit: 200, priceSensitiveOnly: false,
  });
  const rx = new RegExp(`\\b${stockCode}\\b`);
  // Match by stockCode field, headline, OR summary mention — same
  // matching rules as discover so the orchestrator picks the same
  // article discover surfaced.
  const hit = (resp.articles ?? []).find(
    (a) =>
      a.stockCode === stockCode ||
      (a.headline && rx.test(a.headline)) ||
      (a.summary && rx.test(a.summary)),
  );
  if (!hit) return null;
  return {
    headline: hit.headline!,
    source: hit.source,
    url: hit.url,
  };
}

async function getStockMeta(stockCode: string): Promise<{ name: string; pct: number } | null> {
  const resp = await call<{ timeSeries?: TopShort[] }>("GetTopShorts", {
    period: "1y", limit: 100, offset: 0, summaryOnly: true,
  });
  const hit = (resp.timeSeries ?? []).find((s) => s.productCode === stockCode);
  if (!hit) return null;
  return { name: hit.name, pct: hit.latestShortPosition ?? 0 };
}

async function generateBody(
  headline: string,
  stockCode: string,
  shortPct: number,
  sentiment: string,
): Promise<{ bodyMd: string; slug: string; wordCount: number }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const ai = new GoogleGenerativeAI(key);

  const bodyModel = ai.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: TAKE_SYSTEM_PROMPT,
    generationConfig: { temperature: 0.75, maxOutputTokens: 4000 },
  });
  const contextLines = [
    `Headline: ${headline}`,
    `Stock: ${stockCode}`,
    `Short interest at time of news: ${shortPct.toFixed(2)}%`,
    `Sentiment: ${sentiment}`,
    "",
    "Write the Shorted Take now. 180-260 words. Markdown allowed",
    "(paragraphs with blank-line separators, no headings).",
  ].join("\n");
  const bodyResp = await bodyModel.generateContent(contextLines);
  const bodyMd = bodyResp.response.text().trim();
  const wordCount = bodyMd.split(/\s+/).filter(Boolean).length;

  const slugModel = ai.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
  });
  const slugResp = await slugModel.generateContent(
    SLUG_PROMPT.replace("{{HEADLINE}}", headline).replace("{{STOCK_CODE}}", stockCode),
  );
  const slug = slugResp.response.text().trim().toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "")
    .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 80);

  return { bodyMd, slug, wordCount };
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

async function generateHero(
  headline: string,
  stockCode: string,
  slug: string,
): Promise<{ url: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const openai = new OpenAI({ apiKey: key });

  // Inline-built topic. Skip the planner call for the orchestrator path;
  // image-gen pipeline's planner can be invoked separately if richer
  // multi-asset output is needed.
  const topic = `Editorial close-up photograph evoking the article subject (ASX: ${stockCode}): ${headline}. A single concrete physical object on a dark surface with deep shadow, lit by a single warm amber light source from one side. No text, no charts, no people.`;
  const prompt = `${BRAND_PROMPT}\n\n${topic}\n\nFormat: 16:9 horizontal hero banner composition.${FINAL_RULES}`;

  console.log("[run] generating hero image (~30s, ~$0.075)…");
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

  console.log("[run] uploading hero to GCS…");
  const storage = new Storage();
  const objectPath = `takes/${slug}-hero.png`;
  await storage.bucket(GCS_BUCKET).file(objectPath).save(buf, {
    contentType: "image/png",
    resumable: false,
    metadata: { cacheControl: "public, max-age=86400" },
  });
  return { url: `https://storage.googleapis.com/${GCS_BUCKET}/${objectPath}` };
}

async function insertTake(args: {
  slug: string;
  headline: string;
  stockCode: string;
  bodyMd: string;
  sentiment: string;
  sourceUrl?: string;
  sourceName?: string;
  heroImageUrl: string;
  wordCount: number;
  autoPublish: boolean;
}): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const pg = new PgClient({ connectionString: dbUrl });
  await pg.connect();
  try {
    const publishedClause = args.autoPublish ? "NOW()" : "NULL";
    await pg.query(
      `INSERT INTO editorial_takes (
        slug, headline, stock_code, body_md, sentiment,
        source_url, source_name, word_count, model,
        hero_image_url, published_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'gemini-2.5-flash',$9,${publishedClause})
      ON CONFLICT (slug) DO UPDATE SET
        headline=EXCLUDED.headline, body_md=EXCLUDED.body_md,
        sentiment=EXCLUDED.sentiment, hero_image_url=EXCLUDED.hero_image_url,
        word_count=EXCLUDED.word_count, updated_at=NOW()`,
      [args.slug, args.headline, args.stockCode, args.bodyMd, args.sentiment,
       args.sourceUrl ?? null, args.sourceName ?? null, args.wordCount, args.heroImageUrl],
    );
  } finally {
    await pg.end();
  }
}

async function triggerTweet(slug: string): Promise<void> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  const email = process.env.SHORTED_BOT_EMAIL ?? "ben@shorted.com.au";
  if (!secret) {
    console.warn("[run] INTERNAL_SERVICE_SECRET not set — skipping tweet trigger");
    return;
  }
  // Verify the take is in the queue.
  const res = await fetch(
    `${API_URL}/shorts.v1alpha1.ShortedStocksService/ListTweetPublishQueue`,
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "x-internal-secret": secret,
        "x-user-email": email,
        "x-user-id": email,
      },
      body: JSON.stringify({ limit: 20 }),
    },
  );
  if (!res.ok) {
    console.warn(`[run] queue check failed: HTTP ${res.status}`);
    return;
  }
  const data = (await res.json()) as { takes?: Array<{ slug: string }> };
  const found = (data.takes ?? []).some((t) => t.slug === slug);
  if (!found) {
    console.warn(`[run] take ${slug} not in publish queue (race? or already tweeted)`);
    return;
  }
  console.log(
    `[run] take queued. Run \`cd scripts/twitter && npx tsx src/index.ts process-publish-queue --live\` now to tweet.`,
  );
}

export async function runOrchestrator(opts: RunOptions): Promise<void> {
  console.log(`[run] stock=${opts.stockCode} auto-publish=${opts.autoPublish} auto-tweet=${opts.autoTweet}`);

  // 1. Stock metadata
  const meta = await getStockMeta(opts.stockCode);
  if (!meta) throw new Error(`Stock ${opts.stockCode} not in top-shorts pool`);
  console.log(`[run] ${opts.stockCode}: ${meta.name} (${meta.pct.toFixed(2)}% shorted)`);

  // 2. Headline
  let headline = opts.headline;
  let sourceUrl: string | undefined;
  let sourceName: string | undefined;
  if (!headline) {
    console.log("[run] no --headline given; picking top news mention…");
    const picked = await pickHeadline(opts.stockCode);
    if (!picked) {
      throw new Error(`No recent news headlines mention ${opts.stockCode}. Pass --headline=... explicitly or run discover.`);
    }
    headline = picked.headline;
    sourceUrl = picked.url;
    sourceName = picked.source;
    console.log(`[run] headline: "${headline}"`);
    console.log(`[run] source: ${sourceName} — ${sourceUrl}`);
  }

  // 3. Draft body + slug
  console.log("[run] drafting body via Gemini 2.5 Flash…");
  const { bodyMd, slug, wordCount } = await generateBody(
    headline, opts.stockCode, meta.pct, "neutral",
  );
  console.log(`[run] body: ${wordCount} words, slug: ${slug}`);

  // 4. Hero
  const { url: heroImageUrl } = await generateHero(headline, opts.stockCode, slug);
  console.log(`[run] hero: ${heroImageUrl}`);

  // 5. Insert (with optional publish)
  await insertTake({
    slug, headline, stockCode: opts.stockCode, bodyMd, sentiment: "neutral",
    sourceUrl, sourceName, heroImageUrl, wordCount,
    autoPublish: opts.autoPublish,
  });
  console.log(`[run] inserted into editorial_takes${opts.autoPublish ? " (published)" : " (draft)"}`);

  // 6. Tweet trigger
  if (opts.autoTweet) {
    if (!opts.autoPublish) {
      console.warn("[run] --auto-tweet without --auto-publish: skipping (need published_at first)");
    } else {
      await triggerTweet(slug);
    }
  }

  console.log("");
  console.log("=== DONE ===");
  console.log(`Admin:   ${SITE_URL}/admin/takes/${slug}`);
  console.log(`Public:  ${SITE_URL}/news/${slug}${opts.autoPublish ? "" : "  (draft — not yet published)"}`);
  if (!opts.autoPublish) {
    console.log("");
    console.log("To publish: visit the Admin URL above, or re-run with --auto-publish.");
  }
}
