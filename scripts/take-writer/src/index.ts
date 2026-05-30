#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { TAKE_SYSTEM_PROMPT, SLUG_PROMPT } from "./persona.js";
import { discoverCandidates } from "./discover.js";
import { runOrchestrator } from "./run.js";
import { Client as PgClient } from "pg";
import { buildReport } from "./journalism.js";
import { synthesiseNarrative, narrativeToBodyMd } from "./narrative.js";
import { buildAgenda, formatAgendaCandidate } from "./agenda.js";
import { runNewsroom, runNewsroomDaily, runNewsroomPreview, regenerateImages } from "./newsroom.js";

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
  // discover
  poolSize?: number;
  newsWindowHours?: number;
  topN?: number;
  // run orchestrator
  autoPublish?: boolean;
  autoTweet?: boolean;
  // narrative
  inspect?: boolean;
  // newsroom
  withImages?: boolean;
  noImages?: boolean;
  tier?: string;
  angle?: string;
  slug?: string;
  inline?: number;
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
    else if (arg.startsWith("--pool=")) {
      const v = arg.split("=")[1];
      if (v) args.poolSize = parseInt(v, 10);
    } else if (arg.startsWith("--window-hours=")) {
      const v = arg.split("=")[1];
      if (v) args.newsWindowHours = parseInt(v, 10);
    } else if (arg.startsWith("--top=")) {
      const v = arg.split("=")[1];
      if (v) args.topN = parseInt(v, 10);
    } else if (arg === "--auto-publish") {
      args.autoPublish = true;
    } else if (arg === "--auto-tweet") {
      args.autoTweet = true;
    } else if (arg === "--inspect") {
      args.inspect = true;
    } else if (arg === "--with-images") {
      args.withImages = true;
    } else if (arg === "--no-images") {
      args.noImages = true;
    } else if (arg.startsWith("--tier=")) args.tier = arg.split("=")[1];
    else if (arg.startsWith("--angle=")) args.angle = arg.split("=").slice(1).join("=");
    else if (arg.startsWith("--slug=")) args.slug = arg.split("=")[1];
    else if (arg.startsWith("--inline=")) {
      const v = arg.split("=")[1];
      if (v) args.inline = parseInt(v, 10);
    } else if (!arg.startsWith("--") && !args.command) args.command = arg;
  }
  return args;
}

function help(): void {
  console.log(`
@shorted/take-writer — Gemini-driven Shorted Take draft generator

Commands:
  draft     Generate a Take body + slug from a headline
  discover  Rank candidate stocks: top-shorted minus ETFs minus no-news
  run       End-to-end: discover headline + draft + image + insert (+ publish + tweet)
  agenda    Editorial briefing — ranked story candidates with angles
  newsroom        Loop: agenda → top-N narratives → insert as drafts/publish
  newsroom-daily  Investigative daily run: editor -> agentic investigation -> tiered writer
  newsroom-preview Investigate ONE --stock=CODE and print the report (no DB write, no images)
  regen-images    Generate a hero + inline images for an existing take (--slug=SLUG [--inline=2])
  narrative Multi-section journalism-engine Take for one --stock=CODE

run flags:
  --stock=BHP            (required) ASX stock code
  --headline="..."       optional; defaults to top news mention for the stock
  --auto-publish         set published_at = NOW() (skip admin review)
  --auto-tweet           also trigger the tweet queue (requires --auto-publish)

discover flags:
  --pool=30              how many top-shorted stocks to consider
  --window-hours=168     news-coverage window (default 7 days)
  --top=5                how many ranked candidates to return

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
    "  'gemini-2.5-flash'",
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
    model: "gemini-2.5-flash",
    systemInstruction: TAKE_SYSTEM_PROMPT,
    // Gemini 2.5 includes thinking tokens in maxOutputTokens. 600 was
    // enough for 2.0-flash but 2.5 burns most of it thinking. Bump to
    // 4000 to give room for both the reasoning AND the 180-260 word body.
    generationConfig: { temperature: 0.75, maxOutputTokens: 4000 },
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
    model: "gemini-2.5-flash",
    // Same thinking-tokens issue. 500 is plenty for the slug + thinking.
    generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
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

async function runDiscover(args: Args): Promise<void> {
  const candidates = await discoverCandidates({
    poolSize: args.poolSize,
    newsWindowHours: args.newsWindowHours,
    topN: args.topN,
  });
  if (candidates.length === 0) {
    console.log("[take-writer] no candidates passed the filter");
    return;
  }
  console.log(`\n[take-writer] ${candidates.length} candidate(s) ranked by signal:\n`);
  for (const [i, c] of candidates.entries()) {
    console.log(`${i + 1}. ${c.stockCode}  score=${c.score.toFixed(1)}`);
    console.log(`   ${c.name}`);
    console.log(`   ${c.rationale}`);
    if (c.topHeadline) {
      console.log(`   latest: "${c.topHeadline.slice(0, 100)}"`);
      console.log(`   source: ${c.topSource ?? "?"} · sentiment: ${c.topSentiment ?? "?"}`);
    }
    console.log("");
  }
  console.log("Next step: pick one and run `draft --headline=... --stock=...`");
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
    case "discover":
      await runDiscover(args);
      break;
    case "newsroom": {
      // Default to images ON when auto-publishing (live page wants a hero),
      // OFF for drafts (admin can regenerate). --with-images / --no-images
      // override.
      const autoPublish = args.autoPublish ?? false;
      const withImages = args.withImages ?? (autoPublish && !args.noImages);
      await runNewsroom({
        poolSize: args.poolSize,
        topN: args.topN ?? 3,
        autoPublish,
        withImages,
      });
      break;
    }
    case "newsroom-daily": {
      const autoPublish = args.autoPublish ?? false;
      const withImages = args.withImages ?? (autoPublish && !args.noImages);
      await runNewsroomDaily({
        poolSize: args.poolSize,
        maxTakes: args.topN ?? Number(process.env.MAX_TAKES_PER_DAY ?? 10),
        maxDeepDives: Number(process.env.MAX_DEEPDIVES_PER_DAY ?? 2),
        autoPublish,
        withImages,
      });
      break;
    }
    case "newsroom-preview": {
      if (!args.stockCode) throw new Error("--stock=CODE required for newsroom-preview");
      const tier = args.tier === "deep_dive" ? "deep_dive" : "take";
      await runNewsroomPreview({ stockCode: args.stockCode, tier, angle: args.angle });
      break;
    }
    case "regen-images": {
      if (!args.slug && !args.stockCode) throw new Error("--slug=SLUG required for regen-images");
      await regenerateImages({ slug: args.slug ?? "", inlineCount: args.inline });
      break;
    }
    case "agenda": {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) throw new Error("DATABASE_URL not set");
      const pg = new PgClient({ connectionString: dbUrl });
      await pg.connect();
      try {
        const cands = await buildAgenda(pg, {
          poolSize: args.poolSize,
          topN: args.topN,
        });
        if (cands.length === 0) {
          console.log("\n[agenda] no candidates above the score threshold today.");
          break;
        }
        console.log("");
        console.log(`=== Editorial agenda — ${cands.length} story candidates ===`);
        console.log("");
        for (const [i, c] of cands.entries()) {
          console.log(formatAgendaCandidate(c, i));
          console.log("");
        }
      } finally {
        await pg.end();
      }
      break;
    }
    case "narrative": {
      if (!args.stockCode) throw new Error("--stock=CODE required for narrative");
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) throw new Error("DATABASE_URL not set");
      const pg = new PgClient({ connectionString: dbUrl });
      await pg.connect();
      try {
        const code = args.stockCode.toUpperCase();
        const report = await buildReport(pg, code);
        if (args.inspect) {
          console.log(JSON.stringify(report, null, 2));
          break;
        }
        // Run the LLM synthesis.
        console.error(`[narrative] aggregating ${code}: ${report.bundle.shorts.length} shorts, ${report.bundle.prices.length} prices, ${report.bundle.news.length} news, ${report.bundle.directorTrades.length} trades, ${report.bundle.peers.length} peers`);
        console.error(`[narrative] synthesising via Gemini…`);
        const t0 = Date.now();
        const take = await synthesiseNarrative(report);
        const ms = Date.now() - t0;
        console.error(`[narrative] synthesised in ${(ms / 1000).toFixed(1)}s`);
        const bodyMd = narrativeToBodyMd(take);
        const wordCount = bodyMd.split(/\s+/).filter(Boolean).length;
        const out = {
          slug: take.slug,
          headline: take.headline,
          sentiment: take.sentiment,
          word_count: wordCount,
          body_md: bodyMd,
          citations: take.citations,
          sections: {
            background: take.background,
            recent_events: take.recent_events,
            the_data: take.the_data,
            outlook: take.outlook,
          },
        };

        // Persist if --auto-publish, --auto-tweet, or simply asked to.
        if (args.autoPublish || args.autoTweet) {
          const publishedClause = args.autoPublish ? "NOW()" : "NULL";
          await pg.query(
            `INSERT INTO editorial_takes (
               slug, headline, stock_code, body_md, sentiment, word_count, model,
               citations, published_at
             ) VALUES ($1,$2,$3,$4,$5,$6,'gemini-2.5-flash',$7::jsonb,${publishedClause})
             ON CONFLICT (slug) DO UPDATE SET
               headline=EXCLUDED.headline, body_md=EXCLUDED.body_md,
               sentiment=EXCLUDED.sentiment, word_count=EXCLUDED.word_count,
               citations=EXCLUDED.citations, updated_at=NOW()`,
            [take.slug, take.headline, code, bodyMd, take.sentiment, wordCount, JSON.stringify(take.citations)],
          );
          console.error(`[narrative] inserted into editorial_takes${args.autoPublish ? " (published)" : " (draft)"}`);
          console.error("");
          console.error(`Admin:   https://shorted.com.au/admin/takes/${take.slug}`);
          console.error(`Public:  https://shorted.com.au/news/${take.slug}${args.autoPublish ? "" : "  (draft)"}`);
        }

        if (args.out) {
          await import("node:fs").then(({ writeFileSync }) => writeFileSync(args.out!, JSON.stringify(out, null, 2)));
          console.error(`[narrative] wrote → ${args.out}`);
        } else if (!args.autoPublish && !args.autoTweet) {
          console.log(JSON.stringify(out, null, 2));
        }
      } finally {
        await pg.end();
      }
      break;
    }
    case "run": {
      if (!args.stockCode) throw new Error("--stock=CODE is required for run");
      await runOrchestrator({
        stockCode: args.stockCode.toUpperCase(),
        headline: args.headline,
        autoPublish: args.autoPublish ?? false,
        autoTweet: args.autoTweet ?? false,
      });
      break;
    }
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
