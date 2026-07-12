// publish.ts — review + publish flow for editorial_takes drafts.
//
//   list-drafts            table of unpublished drafts (+ --slug for full body review)
//   publish --slug=X       images → validate → publish (→ tweet with --tweet)
//
// Kept separate from index.ts so the CLI entrypoint stays a thin dispatcher.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client as PgClient } from "pg";

import { regenerateImages } from "./newsroom.js";
import { validateArticle } from "./validator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/ lives at scripts/take-writer/src → ../../twitter = scripts/twitter
const TWITTER_DIR = resolve(__dirname, "..", "..", "twitter");

// ---------------------------------------------------------------------------
// Pure decision helper (unit-tested): does this take need image generation?
// True when the hero is missing, the layout plan is empty, or the hero is just
// the brand OG fallback (regenerateImages sets hero=og when the topical hero
// render fails — that means the page never got a real lead image).
// ---------------------------------------------------------------------------

export interface ImageStateRow {
  hero_image_url: string | null;
  og_image_url: string | null;
  layout_images: unknown[] | null;
}

export function needsImages(row: ImageStateRow): boolean {
  if (!row.hero_image_url) return true;
  if (!row.layout_images || row.layout_images.length === 0) return true;
  if (row.og_image_url && row.hero_image_url === row.og_image_url) return true;
  return false;
}

// ---------------------------------------------------------------------------
// list-drafts
// ---------------------------------------------------------------------------

interface DraftRow {
  slug: string;
  stock_code: string;
  tier: string | null;
  headline: string;
  standfirst: string;
  body_format: string | null;
  created: string;
  has_hero: boolean;
  n_layout: number;
  n_cites: number;
}

interface CitationRow {
  refId?: string;
  type?: string;
  headline?: string;
  source?: string;
  date?: string;
  url?: string;
}

function requireDb(): string {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  return dbUrl;
}

export async function listDrafts(opts: { slug?: string } = {}): Promise<void> {
  const pg = new PgClient({ connectionString: requireDb() });
  await pg.connect();
  try {
    if (opts.slug) {
      await printDraftDetail(pg, opts.slug);
      return;
    }
    const { rows } = await pg.query<DraftRow>(
      `SELECT slug, stock_code, tier, headline,
              LEFT(COALESCE(standfirst,''),100) AS standfirst,
              body_format, created_at::date AS created,
              hero_image_url IS NOT NULL AS has_hero,
              jsonb_array_length(COALESCE(layout_images,'[]'::jsonb)) AS n_layout,
              jsonb_array_length(COALESCE(citations,'[]'::jsonb)) AS n_cites
       FROM editorial_takes
       WHERE published_at IS NULL
       ORDER BY created_at DESC
       LIMIT 25`,
    );
    if (rows.length === 0) {
      console.log("[list-drafts] no unpublished drafts.");
      return;
    }
    console.log(`\n=== ${rows.length} unpublished draft(s) ===\n`);
    const slugW = Math.max(4, ...rows.map((r) => r.slug.length));
    const header = `${"SLUG".padEnd(slugW)}  ${"STOCK".padEnd(5)}  ${"TIER".padEnd(9)}  ${"FMT".padEnd(8)}  ${"CREATED".padEnd(10)}  HERO  LAYOUT  CITES`;
    console.log(header);
    console.log("-".repeat(header.length));
    for (const r of rows) {
      const created = String(r.created).slice(0, 10);
      console.log(
        `${r.slug.padEnd(slugW)}  ${r.stock_code.padEnd(5)}  ${(r.tier ?? "-").padEnd(9)}  ${(r.body_format ?? "-").padEnd(8)}  ${created.padEnd(10)}  ${(r.has_hero ? "yes" : "no").padEnd(4)}  ${String(r.n_layout).padEnd(6)}  ${r.n_cites}`,
      );
      console.log(`  ${r.headline}`);
      if (r.standfirst) console.log(`  ${r.standfirst}`);
      console.log(`  review:  npx tsx src/index.ts list-drafts --slug=${r.slug}`);
      console.log(`  publish: npx tsx src/index.ts publish --slug=${r.slug} --tweet`);
      console.log("");
    }
  } finally {
    await pg.end();
  }
}

async function printDraftDetail(pg: PgClient, slug: string): Promise<void> {
  const { rows } = await pg.query<{
    slug: string;
    stock_code: string;
    tier: string | null;
    headline: string;
    standfirst: string | null;
    body_format: string | null;
    body_md: string;
    citations: CitationRow[] | null;
    published_at: string | null;
  }>(
    `SELECT slug, stock_code, tier, headline, standfirst, body_format, body_md, citations, published_at
     FROM editorial_takes WHERE slug=$1`,
    [slug],
  );
  const row = rows[0];
  if (!row) throw new Error(`no editorial_takes row with slug ${slug}`);
  console.log(`\n=== ${row.headline} ===`);
  console.log(
    `slug: ${row.slug} | stock: ${row.stock_code} | tier: ${row.tier ?? "-"} | format: ${row.body_format ?? "-"} | ${row.published_at ? `published ${row.published_at}` : "DRAFT"}`,
  );
  if (row.standfirst) console.log(`\n${row.standfirst}`);
  console.log(`\n${row.body_md}\n`);
  const cites = row.citations ?? [];
  console.log(`--- SOURCES (${cites.length}) ---`);
  for (const c of cites) {
    console.log(`  [${c.refId ?? "?"}] (${c.type ?? "?"}) ${c.headline ?? ""} — ${c.source ?? "?"} ${c.date ?? ""}`);
    if (c.url) console.log(`        ${c.url}`);
  }
  console.log(`\npublish: npx tsx src/index.ts publish --slug=${row.slug} --tweet`);
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

export interface PublishOptions {
  slug: string;
  noImages?: boolean;
  noValidate?: boolean;
  tweet?: boolean;
}

function printLinks(slug: string): void {
  console.log("");
  console.log(`Public: https://shorted.com.au/news/${slug}`);
  console.log(`Admin:  https://shorted.com.au/admin/takes/${slug}`);
  console.log("(ISR: the public page can take up to 10 min to show the new state)");
}

async function tweetTake(slug: string): Promise<void> {
  const manual = `cd ${TWITTER_DIR} && npx tsx src/index.ts process-publish-queue --live --slug=${slug}`;
  console.log(`[publish] tweeting via twitter bot (${TWITTER_DIR})…`);
  const code = await new Promise<number>((resolveExit) => {
    const child = spawn(
      "npx",
      ["tsx", "src/index.ts", "process-publish-queue", "--live", `--slug=${slug}`],
      { cwd: TWITTER_DIR, stdio: "inherit" },
    );
    child.on("error", (err) => {
      console.warn(`[publish] failed to spawn twitter bot: ${String(err)}`);
      resolveExit(1);
    });
    child.on("close", (c) => resolveExit(c ?? 1));
  });
  if (code !== 0) {
    console.warn(`[publish] tweet step exited ${code} — the take IS published; retry manually:`);
    console.warn(`  ${manual}`);
  }
}

export async function publishTake(opts: PublishOptions): Promise<void> {
  const { slug } = opts;
  if (!slug) throw new Error("--slug=SLUG required for publish");

  // 1. Load the take.
  const pg = new PgClient({ connectionString: requireDb() });
  await pg.connect();
  let row: {
    slug: string;
    published_at: string | null;
    hero_image_url: string | null;
    og_image_url: string | null;
    layout_images: unknown[] | null;
    headline: string;
    stock_code: string;
  };
  try {
    const { rows } = await pg.query<typeof row>(
      `SELECT slug, published_at, hero_image_url, og_image_url, layout_images, headline, stock_code
       FROM editorial_takes WHERE slug=$1`,
      [slug],
    );
    const r = rows[0];
    if (!r) throw new Error(`no editorial_takes row with slug ${slug}`);
    row = r;
  } finally {
    await pg.end();
  }
  console.log(`[publish] ${row.stock_code} "${row.headline}"`);

  if (row.published_at) {
    console.log(`[publish] already published at ${row.published_at} — skipping images/validate/publish`);
    if (opts.tweet) await tweetTake(slug);
    printLinks(slug);
    return;
  }

  // 2. Images (default ON; regenerate when missing/empty/og-fallback hero).
  if (opts.noImages) {
    console.log("[publish] --no-images — skipping image generation");
  } else if (needsImages(row)) {
    console.log("[publish] images missing or hero is the brand OG fallback — generating…");
    try {
      await regenerateImages({ slug });
    } catch (err) {
      // Image failure is deliberately FATAL (unlike validation): an article must
      // not go live without its hero. Validation failures only warn.
      throw new Error(
        `image generation failed — publish aborted (article stays draft). ` +
        `Check OPENAI_API_KEY + GOOGLE_APPLICATION_CREDENTIALS (legacy ADC for GCS). ` +
        `Cause: ${String((err as Error).message ?? err)}`,
      );
    }
  } else {
    console.log("[publish] images present — skipping (use regen-images to redo)");
  }

  // 3. Validate (default ON; non-fatal — a judge hiccup shouldn't block publishing).
  if (opts.noValidate) {
    console.log("[publish] --no-validate — skipping cohesion check");
  } else {
    process.env.VALIDATOR_SCREENSHOT = "0"; // draft page isn't live yet — judge per-image
    try {
      await validateArticle(slug, { rounds: 1 });
    } catch (err) {
      console.warn(`[publish] validator failed (continuing): ${String((err as Error).message ?? err).slice(0, 200)}`);
    }
  }

  // 4. Publish.
  const pg2 = new PgClient({ connectionString: requireDb() });
  await pg2.connect();
  try {
    const { rows } = await pg2.query<{ published_at: string }>(
      `UPDATE editorial_takes SET published_at = COALESCE(published_at, NOW()) WHERE slug=$1 RETURNING published_at`,
      [slug],
    );
    console.log(`[publish] published_at = ${rows[0]?.published_at}`);
  } finally {
    await pg2.end();
  }

  // 5. Bust the ISR caches so the take surfaces on the newsdesk immediately
  // (/news is event-driven ISR with a 24h safety net — without this ping a
  // fresh take waits for the next aggregator-driven bust to appear).
  await revalidateNewsSurfaces(slug);

  // 6. Tweet (opt-in).
  if (opts.tweet) await tweetTake(slug);

  // 7. Links.
  printLinks(slug);
}

/**
 * POST the web app's on-demand revalidation endpoint for the surfaces a
 * newly published take appears on. Non-fatal: a failed ping only delays
 * visibility until the next aggregator-driven bust.
 *
 * REVALIDATION_URL defaults to the Vercel origin (not shorted.com.au —
 * Cloudflare's managed challenge blocks non-browser POSTs to the canonical
 * host). REVALIDATION_SECRET comes from prod Secret Manager:
 *   gcloud secrets versions access latest --secret=REVALIDATION_SECRET \
 *     --project=rosy-clover-477102-t5
 */
async function revalidateNewsSurfaces(slug: string): Promise<void> {
  const secret = process.env.REVALIDATION_SECRET;
  const base =
    process.env.REVALIDATION_URL ??
    "https://shorted-com-au-document-analyser.vercel.app/api/revalidate";
  if (!secret) {
    console.warn(
      "[publish] REVALIDATION_SECRET not set — /news may stay stale until the next aggregator run.\n" +
        `  Manual: curl -X POST "${base}?secret=<REVALIDATION_SECRET>&tag=news-index&path=/news,/news/${slug},/"`,
    );
    return;
  }
  const url =
    `${base}?secret=${encodeURIComponent(secret)}` +
    `&tag=news-index&path=${encodeURIComponent(`/news,/news/${slug},/`)}`;
  try {
    const resp = await fetch(url, { method: "POST" });
    const body = (await resp.json().catch(() => ({}))) as {
      revalidated?: boolean;
    };
    if (resp.ok && body.revalidated) {
      console.log(`[publish] revalidated /news, /news/${slug} and /`);
    } else {
      console.warn(`[publish] revalidation ping failed (HTTP ${resp.status})`);
    }
  } catch (e) {
    console.warn(`[publish] revalidation ping failed: ${String(e)}`);
  }
}
