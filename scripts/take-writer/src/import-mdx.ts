// Import a hand-written article into editorial_takes.
//
// Everything else in this tool produces takes via the LLM pipeline
// (draft → newsroom → publish). There was no path for an article a human
// wrote, which is why three pieces ended up in web/_blogs instead of /news —
// the blog is file-based and therefore the only surface you can publish to
// without database access.
//
// This closes that gap. It reads an MDX file with frontmatter and UPSERTS a
// row keyed on slug. It deliberately does NOT set published_at: the article
// lands as a draft and goes live through the same review step as everything
// else (`publish --slug=...`), so a hand-written piece cannot skip the gate
// that LLM-written pieces go through.
//
// Usage:
//   DATABASE_URL=... npx tsx src/index.ts import-mdx --file=../../content/news/foo.mdx
//   DATABASE_URL=... npx tsx src/index.ts import-mdx --dir=../../content/news
//   ... add --dry-run to print what would be written and touch nothing.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client as PgClient } from "pg";

/** The frontmatter contract. Mirrors the editorial_takes columns it feeds. */
export interface TakeFrontmatter {
  slug: string;
  headline: string;
  standfirst?: string;
  byline?: string;
  /** Optional — a market-wide piece (housing, macro) legitimately has none. */
  stockCode?: string;
  /** 'take' | 'deep_dive' */
  tier?: string;
  /** 'markdown' | 'mdx' */
  bodyFormat?: string;
  ogImageUrl?: string;
}

export interface ParsedTake {
  frontmatter: TakeFrontmatter;
  body: string;
  wordCount: number;
}

/**
 * Minimal frontmatter parser — deliberately not gray-matter.
 *
 * This package does not already depend on it, and the contract here is a flat
 * map of quoted strings. Anything richer belongs in the body.
 */
export function parseTakeMdx(raw: string): ParsedTake {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match?.[1] || match[2] === undefined) throw new Error("no frontmatter block found");

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line.trim());
    if (!kv?.[1]) continue;
    frontmatter[kv[1]] = (kv[2] ?? "").replace(/^"(.*)"$/, "$1").trim();
  }

  const body = match[2].trim();

  for (const required of ["slug", "headline"] as const) {
    if (!frontmatter[required]) throw new Error(`frontmatter.${required} is required`);
  }
  if (!body) throw new Error("body is empty");

  // The /news MDX renderer maps standard HTML plus the citation components.
  // A component it does not know renders as nothing, silently — so fail here
  // rather than publish an article with a hole in it.
  const allowed = new Set(["CitationPill", "CitationSources"]);
  const used = [...body.matchAll(/<([A-Z][A-Za-z0-9]*)/g)]
    .map((m) => m[1])
    .filter((c): c is string => Boolean(c));
  const unsupported = [...new Set(used)].filter((c) => !allowed.has(c));
  if (unsupported.length) {
    throw new Error(
      `body uses components the /news renderer does not support: ${unsupported.join(", ")}. ` +
        `Supported: ${[...allowed].join(", ")} plus standard markdown/HTML.`,
    );
  }

  return {
    frontmatter: frontmatter as unknown as TakeFrontmatter,
    body,
    wordCount: body.split(/\s+/).filter(Boolean).length,
  };
}

const UPSERT = `
INSERT INTO editorial_takes
  (slug, headline, standfirst, byline, stock_code, tier, body_format,
   body_md, og_image_url, hero_image_url, word_count, model, updated_at)
-- hero defaults to the cover: /news renders no header image when it is null,
-- which leaves a deep-dive looking unfinished. regen-images replaces it later.
VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8,NULLIF($9,''),NULLIF($9,''),$10,$11,NOW())
ON CONFLICT (slug) DO UPDATE SET
  headline     = EXCLUDED.headline,
  standfirst   = EXCLUDED.standfirst,
  byline       = EXCLUDED.byline,
  stock_code   = EXCLUDED.stock_code,
  tier         = EXCLUDED.tier,
  body_format  = EXCLUDED.body_format,
  body_md      = EXCLUDED.body_md,
  og_image_url = EXCLUDED.og_image_url,
  hero_image_url = COALESCE(editorial_takes.hero_image_url, EXCLUDED.hero_image_url),
  word_count   = EXCLUDED.word_count,
  updated_at   = NOW()
RETURNING slug, published_at
`;

/** Upsert parsed articles into editorial_takes, one row per slug. */
async function upsertParsed(dbUrl: string, parsed: ParsedTake[]): Promise<void> {
  const pg = new PgClient({ connectionString: dbUrl });
  await pg.connect();
  try {
    for (const p of parsed) {
      const fm = p.frontmatter;
      const res = await pg.query(UPSERT, [
        fm.slug,
        fm.headline,
        fm.standfirst ?? null,
        fm.byline ?? null,
        fm.stockCode ?? "",
        fm.tier ?? "take",
        fm.bodyFormat ?? "markdown",
        p.body,
        fm.ogImageUrl ?? "",
        p.wordCount,
        "hand-written",
      ]);
      const row = res.rows[0];
      const state = row.published_at
        ? `ALREADY PUBLISHED ${new Date(row.published_at).toISOString().slice(0, 10)} (content updated in place)`
        : "draft";
      console.log(`  upserted ${row.slug}  [${state}]`);
    }
  } finally {
    await pg.end();
  }
}

export async function importMdx(opts: {
  file?: string;
  dir?: string;
  dryRun?: boolean;
  /**
   * Publish everything imported, in the same run.
   *
   * Off by default on purpose — the draft state is the review gate. This is an
   * explicit opt-in so publishing is always a decision, never a side effect of
   * importing. It skips image generation and the vision cohesion check, which
   * need API keys the import path does not require; run `regen-images` and
   * `validate-article` separately when you have them.
   */
  publish?: boolean;
}): Promise<void> {
  const files: string[] = [];
  if (opts.file) files.push(resolve(opts.file));
  if (opts.dir) {
    const dir = resolve(opts.dir);
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".mdx")) files.push(join(dir, name));
    }
  }
  if (!files.length) throw new Error("--file=... or --dir=... required");

  const parsed = files.map((f) => {
    try {
      return { file: f, ...parseTakeMdx(readFileSync(f, "utf8")) };
    } catch (err) {
      throw new Error(`${f}: ${err instanceof Error ? err.message : err}`);
    }
  });

  if (opts.dryRun) {
    console.log("DRY RUN — nothing will be written.\n");
    for (const p of parsed) {
      const fm = p.frontmatter;
      console.log(
        `  ${fm.slug}\n     headline: ${fm.headline}\n     stock: ${fm.stockCode || "(none)"}  tier: ${fm.tier ?? "take"}  format: ${fm.bodyFormat ?? "markdown"}  words: ${p.wordCount}`,
      );
    }
    console.log(`\n${parsed.length} article(s) would be upserted as DRAFTS.`);
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");

  await upsertParsed(dbUrl, parsed);

  if (!opts.publish) {
    console.log("\nreview:  npx tsx src/index.ts list-drafts");
    console.log("publish: npx tsx src/index.ts publish --slug=<slug>");
    console.log("     or: re-run this command with --publish");
    return;
  }

  console.log("\n--publish: publishing all imported articles\n");
  const { publishTake } = await import("./publish.js");
  for (const p of parsed) {
    await publishTake({
      slug: p.frontmatter.slug,
      noImages: true,
      noValidate: true,
    });
  }
}

// --- publish-content: the Cloud Run entrypoint ------------------------------
//
// The shorted-news-publish job runs this, with the slug supplied by the shorts
// API (POST /api/admin/news/publish), which validates it against the same
// pattern before building the argv. The content/news directory is baked into
// the image at build time, so what gets published is exactly what was merged
// to main — the API never carries an article body.

/**
 * The slug shape. Deliberately narrower than what import-mdx accepts from a
 * file: this one arrives from the network. Mirrored in the shorts API
 * (services/shorts/internal/jobmonitor/publish.go `slugPattern`) — change both.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 120;

export function assertValidSlug(slug: string): void {
  if (!slug || slug.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(slug)) {
    throw new Error(`invalid slug ${JSON.stringify(slug)}: want lowercase kebab-case, <= ${MAX_SLUG_LENGTH} chars`);
  }
}

/** Where the article files live: CONTENT_DIR (the image sets it), else the repo layout. */
export function defaultContentDir(): string {
  return process.env.CONTENT_DIR || resolve("../../content/news");
}

/**
 * Find the file whose FRONTMATTER slug matches. Files are matched on their
 * contents, not their names, because the slug is what the row is keyed on and
 * a file can be renamed without changing it. Exactly one match is required.
 */
export function findContentBySlug(dir: string, slug: string): { file: string; parsed: ParsedTake } {
  assertValidSlug(slug);
  const matches: { file: string; parsed: ParsedTake }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".mdx")) continue;
    const file = join(dir, name);
    let parsed: ParsedTake;
    try {
      parsed = parseTakeMdx(readFileSync(file, "utf8"));
    } catch {
      // A broken sibling must not block publishing a good article; it will
      // fail loudly the day someone tries to publish IT.
      continue;
    }
    if (parsed.frontmatter.slug === slug) matches.push({ file, parsed });
  }
  if (matches.length === 0) {
    throw new Error(`no article with slug ${slug} in ${dir} — is it merged to main, and was the image rebuilt since?`);
  }
  if (matches.length > 1) {
    throw new Error(`slug ${slug} is claimed by ${matches.length} files: ${matches.map((m) => m.file).join(", ")}`);
  }
  return matches[0]!;
}

/**
 * Import ONE article by slug and publish it through the full chain
 * (images -> validate -> published_at -> revalidate). Idempotent: an article
 * that is already published has its content updated in place and nothing else.
 */
export async function publishContent(opts: {
  slug?: string;
  dir?: string;
  noImages?: boolean;
  noValidate?: boolean;
}): Promise<void> {
  if (!opts.slug) throw new Error("--slug=SLUG required for publish-content");
  const dir = resolve(opts.dir ?? defaultContentDir());
  const { file, parsed } = findContentBySlug(dir, opts.slug);
  console.log(`[publish-content] ${opts.slug} <- ${file} (${parsed.wordCount} words)`);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  await upsertParsed(dbUrl, [parsed]);

  const { publishTake } = await import("./publish.js");
  await publishTake({
    slug: opts.slug,
    noImages: opts.noImages,
    noValidate: opts.noValidate,
  });
}
