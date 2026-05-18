#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { TAKE_SYSTEM_PROMPT, SLUG_PROMPT } from "./persona.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const envCandidates = [
  resolve(__dirname, "..", ".env"),
  resolve(__dirname, "..", "..", "..", ".env"),
  resolve(__dirname, "..", "..", "..", "services", ".env"),
];
for (const p of envCandidates) {
  if (existsSync(p)) loadDotenv({ path: p, override: false });
}

interface Args {
  command: string;
  headline?: string;
  stockCode?: string;
  shortPct?: number;
  sentiment?: string;
  sourceUrl?: string;
  sourceName?: string;
  sourceArticleId?: string;
  out?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "", help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--headline=")) args.headline = arg.split("=").slice(1).join("=");
    else if (arg.startsWith("--stock=")) args.stockCode = arg.split("=")[1];
    else if (arg.startsWith("--short-pct=")) {
      const v = arg.split("=")[1];
      if (v !== undefined) args.shortPct = parseFloat(v);
    } else if (arg.startsWith("--sentiment=")) args.sentiment = arg.split("=")[1];
    else if (arg.startsWith("--source-url=")) args.sourceUrl = arg.split("=").slice(1).join("=");
    else if (arg.startsWith("--source-name=")) args.sourceName = arg.split("=").slice(1).join("=");
    else if (arg.startsWith("--source-article-id=")) args.sourceArticleId = arg.split("=")[1];
    else if (arg.startsWith("--out=")) args.out = arg.split("=")[1];
    else if (!arg.startsWith("--") && !args.command) args.command = arg;
  }
  return args;
}

function help(): void {
  console.log(`
@shorted/take-writer — Gemini-driven Shorted Take draft generator

Commands:
  draft    Generate a Take body + slug from a headline

draft flags:
  --headline="..."           (required) the source headline
  --stock=BHP                (required) ASX stock code
  --short-pct=16.4           short interest % at time of news (optional context)
  --sentiment=negative       positive|negative|neutral (optional context)
  --source-url="..."         external publisher URL (recorded for attribution)
  --source-name="Stockhead"  publisher name
  --source-article-id=UUID   FK to news_articles.id (optional)
  --out=/tmp/take.json       write structured output to file

Output: JSON with {slug, headline, body_md, suggested_insert_sql}.
Take is created with published_at=NULL → admin queue, not auto-publish.

Example:
  tsx src/index.ts draft \\
    --headline="Lotus Resources slides as JPMorgan downgrades on price thesis" \\
    --stock=LOT \\
    --short-pct=16.0 \\
    --sentiment=negative \\
    --source-url=https://www.stockhead.com.au/...lot-downgrade \\
    --source-name=Stockhead
`);
}

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

function buildInsertSql(t: {
  slug: string;
  headline: string;
  stockCode: string;
  bodyMd: string;
  sentiment?: string;
  sourceArticleId?: string;
  sourceUrl?: string;
  sourceName?: string;
  wordCount: number;
}): string {
  const stockClause = `'${escapeSqlString(t.stockCode)}'`;
  const sentimentClause = t.sentiment ? `'${escapeSqlString(t.sentiment)}'` : "NULL";
  const srcIdClause = t.sourceArticleId ? `'${t.sourceArticleId}'::uuid` : "NULL";
  const srcUrlClause = t.sourceUrl ? `'${escapeSqlString(t.sourceUrl)}'` : "NULL";
  const srcNameClause = t.sourceName ? `'${escapeSqlString(t.sourceName)}'` : "NULL";
  return [
    "-- Run against the shorts database. published_at left NULL so the Take",
    "-- is in the admin queue. Flip to NOW() after review to publish.",
    "INSERT INTO editorial_takes (",
    "  slug, headline, stock_code, body_md, sentiment,",
    "  source_article_id, source_url, source_name, word_count, model",
    ") VALUES (",
    `  '${escapeSqlString(t.slug)}',`,
    `  '${escapeSqlString(t.headline)}',`,
    `  ${stockClause},`,
    `  $body$${t.bodyMd}$body$,`,
    `  ${sentimentClause},`,
    `  ${srcIdClause},`,
    `  ${srcUrlClause},`,
    `  ${srcNameClause},`,
    `  ${t.wordCount},`,
    "  'gemini-2.0-flash'",
    ");",
  ].join("\n");
}

async function runDraft(args: Args): Promise<void> {
  if (!args.headline) throw new Error("--headline=\"...\" required");
  if (!args.stockCode) throw new Error("--stock=CODE required");
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenerativeAI(key);
  const bodyModel = ai.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: TAKE_SYSTEM_PROMPT,
    generationConfig: { temperature: 0.75, maxOutputTokens: 600 },
  });

  const contextLines = [
    `Headline: ${args.headline}`,
    `Stock: ${args.stockCode}`,
    args.shortPct != null ? `Short interest at time of news: ${args.shortPct.toFixed(2)}%` : "",
    args.sentiment ? `Sentiment: ${args.sentiment}` : "",
    args.sourceName ? `Reported by: ${args.sourceName}` : "",
    "",
    "Write the Shorted Take now. 180-260 words. Markdown allowed",
    "(paragraphs with blank-line separators, no headings, no lists",
    "unless the content is genuinely list-shaped).",
  ].filter(Boolean).join("\n");

  console.log("[take-writer] generating body…");
  const bodyResp = await bodyModel.generateContent(contextLines);
  const bodyMd = bodyResp.response.text().trim();
  const wordCount = bodyMd.split(/\s+/).filter(Boolean).length;

  console.log(`[take-writer] body: ${wordCount} words`);

  // Slug via a separate, lower-temperature call.
  const slugModel = ai.getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig: { temperature: 0.2, maxOutputTokens: 30 },
  });
  const slugPrompt = SLUG_PROMPT
    .replace("{{HEADLINE}}", args.headline)
    .replace("{{STOCK_CODE}}", args.stockCode);
  const slugResp = await slugModel.generateContent(slugPrompt);
  const slug = slugResp.response.text().trim().toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  console.log(`[take-writer] slug: ${slug}`);

  const result = {
    slug,
    headline: args.headline,
    stock_code: args.stockCode,
    body_md: bodyMd,
    word_count: wordCount,
    sentiment: args.sentiment,
    source_url: args.sourceUrl,
    source_name: args.sourceName,
    source_article_id: args.sourceArticleId,
    suggested_insert_sql: buildInsertSql({
      slug,
      headline: args.headline,
      stockCode: args.stockCode,
      bodyMd,
      sentiment: args.sentiment,
      sourceArticleId: args.sourceArticleId,
      sourceUrl: args.sourceUrl,
      sourceName: args.sourceName,
      wordCount,
    }),
  };

  const json = JSON.stringify(result, null, 2);
  if (args.out) {
    writeFileSync(args.out, json);
    console.log(`[take-writer] wrote → ${args.out}`);
  } else {
    console.log("\n" + json);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    help();
    process.exit(args.help ? 0 : 1);
  }
  switch (args.command) {
    case "draft":
      await runDraft(args);
      break;
    default:
      console.error(`[take-writer] unknown command: ${args.command}`);
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[take-writer] failed:", err.message ?? err);
  process.exit(1);
});
