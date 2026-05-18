#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

import { createClient, type TwitterClient, type TweetMedia } from "./twitter-client.js";
import { bootstrapOAuth2 } from "./oauth2-bootstrap.js";
import {
  buildBreakingNewsTweet,
  buildDailyShortsTweet,
  buildInsiderTradeTweet,
  buildMoversTweet,
  buildStockOfTheDayTweet,
  buildWeeklyDigestThread,
} from "./templates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env from script root first, then fall back to repo root.
// Repo-root .env is convenient for shared credentials (e.g. the same
// TWITTER_* vars used by other repo tooling) without copy-pasting.
const localEnv = resolve(__dirname, "..", ".env");
const repoEnv = resolve(__dirname, "..", "..", "..", ".env");
if (existsSync(localEnv)) {
  loadDotenv({ path: localEnv });
}
if (existsSync(repoEnv)) {
  loadDotenv({ path: repoEnv, override: false });
}

interface Args {
  command: string;
  dryRun: boolean;
  stockCode?: string;
  help: boolean;
  noImage: boolean;
  imagePath?: string;
}

const SITE_ORIGIN =
  process.env.SHORTED_SITE_ORIGIN ?? "https://shorted.com.au";

function loadMediaFromPath(p: string): TweetMedia | undefined {
  try {
    const buffer = readFileSync(p);
    const ext = p.toLowerCase().split(".").pop();
    const mediaType: TweetMedia["mediaType"] =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    const size = statSync(p).size;
    if (size < 1000) {
      console.warn(`[twitter] image-path file too small (${size}b); skipping media`);
      return undefined;
    }
    return { buffer, mediaType };
  } catch (err) {
    console.warn(`[twitter] could not read --image-path: ${String(err)}`);
    return undefined;
  }
}

async function resolveMedia(
  args: Args,
  fallbackType: string,
): Promise<TweetMedia | undefined> {
  if (args.noImage) return undefined;
  if (args.imagePath) return loadMediaFromPath(args.imagePath);
  return fetchInfographic(fallbackType);
}

async function fetchInfographic(type: string): Promise<TweetMedia | undefined> {
  try {
    const res = await fetch(`${SITE_ORIGIN}/api/og/twitter/${type}`);
    if (!res.ok) {
      console.warn(`[twitter] infographic fetch failed (${res.status}); posting text-only`);
      return undefined;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) {
      console.warn(`[twitter] infographic too small (${buf.length}b); posting text-only`);
      return undefined;
    }
    return { buffer: buf, mediaType: "image/png" };
  } catch (err) {
    console.warn(`[twitter] infographic error: ${String(err)}; posting text-only`);
    return undefined;
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    dryRun: process.env.TWITTER_DRY_RUN_DEFAULT !== "false",
    help: false,
    noImage: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--live") args.dryRun = false;
    else if (arg === "--no-image") args.noImage = true;
    else if (arg.startsWith("--image-path=")) args.imagePath = arg.split("=").slice(1).join("=");
    else if (arg.startsWith("--stock=")) args.stockCode = arg.split("=")[1];
    else if (!arg.startsWith("--") && !args.command) args.command = arg;
  }
  return args;
}

function printHelp() {
  console.log(`
Shorted Twitter bot

Usage:
  npm run post:daily-shorts        Most-shorted top 5, daily AM tweet
  npm run post:movers              Biggest WoW short-interest changes
  npm run post:stock-of-the-day    Spotlight on the #1 most-shorted stock
  npm run post:weekly-digest       Friday-evening 4-tweet thread
  npm run post:breaking-news       Latest price-sensitive news article

Or directly:
  tsx src/index.ts <command> [flags]

Flags:
  --dry-run         Print the tweet but don't post (default unless
                    TWITTER_DRY_RUN_DEFAULT=false in .env)
  --live            Override dry-run; actually post the tweet
  --stock=CBA       For insider-trade alerts, the stock code to check

Commands:
  bootstrap-oauth2     One-time: get an OAuth 2.0 refresh_token
  daily-shorts
  movers
  stock-of-the-day
  weekly-digest
  breaking-news
  insider-trade        Requires --stock=CODE

Examples:
  npm run post:daily-shorts                    # dry-run (default)
  tsx src/index.ts daily-shorts --live         # actually posts
  tsx src/index.ts insider-trade --stock=BHP   # dry-run, BHP insider trades
`);
}

async function run(command: string, client: TwitterClient, args: Args) {
  if (command === "bootstrap-oauth2") {
    await bootstrapOAuth2();
    return;
  }
  switch (command) {
    case "daily-shorts": {
      const text = await buildDailyShortsTweet();
      const media = await resolveMedia(args, "top-shorts");
      await client.postTweet(text, media);
      break;
    }
    case "movers": {
      const text = await buildMoversTweet();
      await client.postTweet(text);
      break;
    }
    case "stock-of-the-day": {
      const text = await buildStockOfTheDayTweet();
      const media = await resolveMedia(args, "stock-of-day");
      await client.postTweet(text, media);
      break;
    }
    case "weekly-digest": {
      const thread = await buildWeeklyDigestThread();
      await client.postThread(thread);
      break;
    }
    case "breaking-news": {
      const text = await buildBreakingNewsTweet();
      if (!text) {
        console.log("No qualifying breaking news to post right now.");
        return;
      }
      await client.postTweet(text);
      break;
    }
    case "insider-trade": {
      if (!args.stockCode) {
        throw new Error("--stock=CODE required for insider-trade");
      }
      const text = await buildInsiderTradeTweet(args.stockCode.toUpperCase());
      if (!text) {
        console.log(
          `No qualifying insider trade (>$100k) for ${args.stockCode}.`,
        );
        return;
      }
      await client.postTweet(text);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  console.log(`[twitter] command=${args.command} dry_run=${args.dryRun}`);

  try {
    if (args.command === "bootstrap-oauth2") {
      await bootstrapOAuth2();
      return;
    }
    const client = createClient({ dryRun: args.dryRun });
    await run(args.command, client, args);
    console.log(`[twitter] done (${args.dryRun ? "dry-run" : "posted"}).`);
  } catch (err) {
    console.error(`[twitter] failed:`, err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
