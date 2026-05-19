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
import { buildAgenda, type AgendaCandidate, type AgendaAngle } from "./agenda.js";
import { synthesiseNarrative, narrativeToBodyMd, type NarrativeTake } from "./narrative.js";

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

async function generateHero(
  openai: OpenAI,
  storage: Storage,
  candidate: AgendaCandidate,
  take: NarrativeTake,
): Promise<{ url: string; costUsd: number }> {
  const topic = `Editorial close-up photograph evoking the article subject (ASX: ${candidate.stockCode}): ${take.headline}. A single concrete physical object on a dark surface with deep shadow, lit by a single warm amber light source from one side. No text, no charts, no people.`;
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

async function insertTake(
  pg: PgClient,
  candidate: AgendaCandidate,
  take: NarrativeTake,
  bodyMd: string,
  heroUrl: string | null,
  publish: boolean,
): Promise<void> {
  const publishedClause = publish ? "NOW()" : "NULL";
  await pg.query(
    `INSERT INTO editorial_takes (
       slug, headline, stock_code, body_md, sentiment, word_count, model,
       citations, hero_image_url, published_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'gemini-2.5-flash',$7::jsonb,$8,${publishedClause})
     ON CONFLICT (slug) DO UPDATE SET
       headline=EXCLUDED.headline, body_md=EXCLUDED.body_md,
       sentiment=EXCLUDED.sentiment, word_count=EXCLUDED.word_count,
       citations=EXCLUDED.citations, hero_image_url=COALESCE(EXCLUDED.hero_image_url, editorial_takes.hero_image_url),
       updated_at=NOW()`,
    [
      take.slug, take.headline, candidate.stockCode,
      bodyMd, take.sentiment, bodyMd.split(/\s+/).filter(Boolean).length,
      JSON.stringify(take.citations), heroUrl,
    ],
  );
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
        if (opts.withImages && openai && storage) {
          console.log(`${tag}   generating hero image (~30s, ~$0.075)…`);
          const img = await generateHero(openai, storage, c, take);
          heroUrl = img.url;
          costUsd += img.costUsd;
        }

        await insertTake(pg, c, take, bodyMd, heroUrl, opts.autoPublish);

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
