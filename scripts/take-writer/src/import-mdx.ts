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
import { z } from "zod";
import { COMPONENT_SCHEMAS, validateMdx } from "./mdxgate.js";
import type { Citation } from "./narrative.js";

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
  /** Explicit reviewed hero replacement; omitted fields preserve legacy behavior. */
  heroImageUrl?: string;
  heroCaption?: string;
  heroCredit?: string;
  /** JSON array on one frontmatter line; persisted with its original IDs. */
  citations?: Citation[];
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
 * map of quoted strings, with citations encoded as a JSON array on one line.
 */
export function parseTakeMdx(raw: string): ParsedTake {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match?.[1] || match[2] === undefined) throw new Error("no frontmatter block found");

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    const value = (kv[2] ?? "").trim();
    // JSON-quoted strings support escaped punctuation without adding a YAML
    // dependency to the job. Citation arrays use JSON in the same flat contract.
    frontmatter[kv[1]] = value.startsWith('"') ? JSON.parse(value) : value;
  }

  const body = match[2].trim();

  for (const required of ["slug", "headline"] as const) {
    if (!frontmatter[required]) throw new Error(`frontmatter.${required} is required`);
  }
  if (!body) throw new Error("body is empty");
  const heroFields = ["heroImageUrl", "heroCaption", "heroCredit"] as const;
  if (heroFields.some((field) => frontmatter[field] !== undefined)) {
    if (heroFields.some((field) => typeof frontmatter[field] !== "string" || !frontmatter[field]?.trim())) {
      throw new Error("explicit hero metadata requires a nonempty heroImageUrl, heroCaption and heroCredit together");
    }
    let heroUrl: URL;
    try { heroUrl = new URL(frontmatter.heroImageUrl!); } catch {
      throw new Error("explicit heroImageUrl requires an absolute HTTPS URL");
    }
    if (heroUrl.protocol !== "https:") throw new Error("explicit heroImageUrl requires an absolute HTTPS URL");
  }

  // The /news MDX renderer maps standard HTML, citations and the newsroom palette.
  // A component it does not know renders as nothing, silently — so fail here
  // rather than publish an article with a hole in it.
  const allowed = new Set(["CitationPill", "CitationSources", ...Object.keys(COMPONENT_SCHEMAS)]);
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

  const citations = frontmatter.citations === undefined
    ? undefined
    : parseCitations(frontmatter.citations);
  return {
    frontmatter: { ...frontmatter, citations } as unknown as TakeFrontmatter,
    body,
    wordCount: body.split(/\s+/).filter(Boolean).length,
  };
}

const CITATION_SCHEMA = z.object({
  refId: z.string().regex(/^(?:ref|report)-[1-9]\d*$/),
  url: z.string().url().refine((url) => ["http:", "https:"].includes(new URL(url).protocol)),
  source: z.string().trim().min(1),
  headline: z.string().min(1),
  date: z.string().regex(/^(?:\d{4}-\d{2}-\d{2})?$/),
  type: z.enum(["news", "trade", "data", "report"]),
});

function parseCitations(raw: string): Citation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("frontmatter.citations must be a JSON array on one line");
  }
  const citations = z.array(CITATION_SCHEMA).parse(parsed);
  if (new Set(citations.map((c) => c.refId)).size !== citations.length) {
    throw new Error("frontmatter.citations contains duplicate refIds");
  }
  return citations;
}

/** Validate actual newsroom props/refs before any database write. */
export async function validateImportedTake(parsed: ParsedTake): Promise<void> {
  if (parsed.frontmatter.bodyFormat !== "mdx") return;
  // Legacy handwritten files used the two direct citation components. Keep
  // their existing contract; new newsroom components use the shared MDX gate.
  if (/<(?:CitationPill|CitationSources)\b/.test(parsed.body)) {
    if (Object.keys(COMPONENT_SCHEMAS).some((name) => new RegExp(`<${name}\\b`).test(parsed.body))) {
      throw new Error("legacy citation components cannot be mixed with newsroom MDX components");
    }
    return;
  }
  const result = await validateMdx(parsed.body, {
    ledgerRefs: new Set((parsed.frontmatter.citations ?? []).map((c) => c.refId)),
    knownCodes: new Set(parsed.frontmatter.stockCode ? [parsed.frontmatter.stockCode] : []),
  });
  if (!result.ok) throw new Error(`invalid article MDX: ${result.errors.join("; ")}`);
  for (const marker of parsed.body.matchAll(/\[((?:ref|report)-\d+)\]/g)) {
    if (!(parsed.frontmatter.citations ?? []).some((c) => c.refId === marker[1])) {
      throw new Error(`article citation ${marker[1]} is missing from frontmatter.citations`);
    }
  }
}

const UPSERT = `
INSERT INTO editorial_takes
  (slug, headline, standfirst, byline, stock_code, tier, body_format,
   body_md, og_image_url, hero_image_url, word_count, model, citations, hero_caption, hero_credit, updated_at)
-- hero defaults to the cover: /news renders no header image when it is null,
-- which leaves a deep-dive looking unfinished. regen-images replaces it later.
VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8,NULLIF($9,''),COALESCE(NULLIF($13,''),NULLIF($9,'')),$10,$11,COALESCE($12::jsonb,'[]'::jsonb),$14,$15,NOW())
ON CONFLICT (slug) DO UPDATE SET
  headline     = EXCLUDED.headline,
  standfirst   = EXCLUDED.standfirst,
  byline       = EXCLUDED.byline,
  stock_code   = EXCLUDED.stock_code,
  tier         = EXCLUDED.tier,
  body_format  = EXCLUDED.body_format,
  body_md      = EXCLUDED.body_md,
  og_image_url = EXCLUDED.og_image_url,
  hero_image_url = CASE WHEN NULLIF($13,'') IS NOT NULL THEN EXCLUDED.hero_image_url ELSE COALESCE(editorial_takes.hero_image_url, EXCLUDED.hero_image_url) END,
  hero_caption = COALESCE(EXCLUDED.hero_caption, editorial_takes.hero_caption),
  hero_credit = COALESCE(EXCLUDED.hero_credit, editorial_takes.hero_credit),
  word_count   = EXCLUDED.word_count,
  citations    = CASE WHEN $12::jsonb IS NULL THEN editorial_takes.citations ELSE EXCLUDED.citations END,
  updated_at   = NOW()
RETURNING slug, published_at
`;

/** Upsert parsed articles into editorial_takes, one row per slug. */
async function upsertParsed(dbUrl: string, parsed: ParsedTake[], draftOnly = false): Promise<void> {
  const pg = new PgClient({ connectionString: dbUrl });
  await pg.connect();
  try {
    for (const p of parsed) {
      const fm = p.frontmatter;
      // A repeated publish-content invocation must not edit a live article
      // before its review. Keep the ordinary draft import/update flow separate.
      const sql = draftOnly ? UPSERT.replace("\nRETURNING slug", "\nWHERE editorial_takes.published_at IS NULL\nRETURNING slug") : UPSERT;
      const res = await pg.query(sql, [
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
        fm.citations === undefined ? null : JSON.stringify(fm.citations),
        fm.heroImageUrl ?? null,
        fm.heroCaption ?? null,
        fm.heroCredit ?? null,
      ]);
      const row = res.rows[0];
      if (!row) throw new Error("publish-content cannot overwrite a published article; use a reviewed update flow");
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
   * Legacy bulk-publication flag. Rejected before writing: use publish-content
   * for each article so its required vision review cannot be skipped.
   */
  publish?: boolean;
}): Promise<void> {
  if (opts.publish) throw new Error("import-mdx creates drafts; use publish-content for required vision review");
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
  for (const article of parsed) await validateImportedTake(article);

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

  console.log("\nreview:  npx tsx src/index.ts list-drafts");
  console.log("publish: npx tsx src/index.ts publish --slug=<slug>");
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
 * that is already published cannot be overwritten by this draft publication path.
 */
export async function publishContent(opts: {
  slug?: string;
  dir?: string;
  noImages?: boolean;
  noValidate?: boolean;
}): Promise<void> {
  if (!opts.slug) throw new Error("--slug=SLUG required for publish-content");
  if (opts.noValidate) throw new Error("publish-content requires vision validation; --no-validate is not supported");
  const dir = resolve(opts.dir ?? defaultContentDir());
  const { file, parsed } = findContentBySlug(dir, opts.slug);
  await validateImportedTake(parsed);
  console.log(`[publish-content] ${opts.slug} <- ${file} (${parsed.wordCount} words)`);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  await upsertParsed(dbUrl, [parsed], true);

  const { publishTake } = await import("./publish.js");
  await publishTake({
    slug: opts.slug,
    noImages: opts.noImages,
    noValidate: opts.noValidate,
  });
}
