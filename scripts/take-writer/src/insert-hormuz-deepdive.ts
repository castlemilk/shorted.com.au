/**
 * One-off: hand-assembled Hormuz crisis deep-dive. Reads the repo-root
 * hormuz-asx-energy-deep-dive.mdx (frontmatter + body + trailing Sources
 * block), converts the Sources block into the citations jsonb, runs the MDX
 * gate, and upserts as a DRAFT (published_at untouched on conflict).
 *
 * Source-line format (one per line, URL required):
 *   [ref-1] Publisher — "Headline", 10 July 2026 — https://example.com/x
 *
 * Run: cd scripts/take-writer && DATABASE_URL=... npx tsx src/insert-hormuz-deepdive.ts [--file=path]
 */
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import { validateMdx } from "./mdxgate";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(HERE, "../../../hormuz-asx-energy-deep-dive.mdx");

const stockCode = "WDS";
const sentiment = "neutral";
const model = "hand-assembled";
// ASX codes the article's charts may reference.
const KNOWN_CODES = new Set(["WDS", "STO", "BPT", "KAR", "PDN"]);

interface Citation {
  refId: string;
  type: string;
  source: string;
  url: string;
  headline: string;
  date: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no frontmatter block found");
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

function splitSources(body: string): { body: string; citations: Citation[] } {
  // Sources trailer: a "**Sources**" line (optionally preceded by an hr)
  // followed by [ref-N] lines.
  const idx = body.search(/^(---\n+)?\*\*Sources\*\*\s*$/m);
  if (idx === -1) throw new Error("no **Sources** block found");
  const article = body.slice(0, idx).replace(/\n*---\n*$/, "").trim();
  const trailer = body.slice(idx);

  const citations: Citation[] = [];
  const lineRe =
    /^\[ref-(\d+)\]\s+(.+?)\s+—\s+[“"](.+?)[”"],\s*(.+?)\s+—\s+(https?:\/\/\S+)\s*$/;
  for (const line of trailer.split("\n")) {
    if (!line.startsWith("[ref-")) continue;
    const m = line.match(lineRe);
    if (!m) throw new Error(`unparseable source line (need: [ref-N] Publisher — "Title", date — URL):\n  ${line}`);
    citations.push({
      refId: `ref-${m[1]}`,
      type: "news",
      source: m[2]!,
      headline: m[3]!,
      date: m[4]!,
      url: m[5]!,
    });
  }
  if (citations.length === 0) throw new Error("Sources block parsed to zero citations");
  return { body: article, citations };
}

async function main() {
  const fileArg = process.argv.find((a) => a.startsWith("--file="));
  const file = fileArg ? resolve(fileArg.slice(7)) : DEFAULT_FILE;
  const raw = readFileSync(file, "utf8");

  const { meta, body: fullBody } = parseFrontmatter(raw);
  for (const k of ["slug", "headline", "standfirst", "byline", "tier", "body_format"]) {
    if (!meta[k]) throw new Error(`frontmatter missing ${k}`);
  }
  const { body, citations } = splitSources(fullBody);

  // Every bracketed marker (and cite= prop) must resolve to a citation.
  const ledgerRefs = new Set(citations.map((c) => c.refId));
  const used = new Set([
    ...[...body.matchAll(/\[(ref-\d+)\]/g)].map((m) => m[1]!),
    ...[...body.matchAll(/cite="(ref-\d+)"/g)].map((m) => m[1]!),
  ]);
  const dangling = [...used].filter((r) => !ledgerRefs.has(r));
  if (dangling.length) throw new Error(`markers with no source: ${dangling.join(", ")}`);
  const unused = [...ledgerRefs].filter((r) => !used.has(r));
  if (unused.length) console.warn(`[warn] citations never referenced in prose: ${unused.join(", ")}`);

  const gate = await validateMdx(body, { ledgerRefs, knownCodes: KNOWN_CODES });
  if (!gate.ok) {
    throw new Error(`MDX gate failed:\n  ${gate.errors.join("\n  ")}`);
  }
  console.log(`[gate] ok — ${gate.componentCount} components, ${citations.length} citations, ${used.size} cited in prose`);

  if (process.argv.includes("--dry-run")) {
    console.log("[dry-run] not writing to DB");
    return;
  }

  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const res = await pool.query(
    `INSERT INTO editorial_takes (
       slug, headline, stock_code, body_md, sentiment, word_count, model, tier,
       citations, body_format, standfirst, byline, published_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,NULL)
     ON CONFLICT (slug) DO UPDATE SET
       headline=EXCLUDED.headline, body_md=EXCLUDED.body_md, tier=EXCLUDED.tier,
       sentiment=EXCLUDED.sentiment, word_count=EXCLUDED.word_count,
       citations=EXCLUDED.citations, body_format=EXCLUDED.body_format,
       standfirst=EXCLUDED.standfirst, byline=EXCLUDED.byline, updated_at=NOW()
     RETURNING slug, word_count, published_at`,
    [
      meta.slug, meta.headline, stockCode, body, sentiment, wordCount, model,
      meta.tier, JSON.stringify(citations), meta.body_format, meta.standfirst,
      meta.byline,
    ],
  );
  console.log("Inserted/updated draft:", res.rows[0]);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
