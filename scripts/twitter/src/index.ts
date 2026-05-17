#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

import { createClient, type TwitterClient } from "./twitter-client.js";
import {
  buildBreakingNewsTweet,
  buildDailyShortsTweet,
  buildInsiderTradeTweet,
  buildMoversTweet,
  buildStockOfTheDayTweet,
  buildWeeklyDigestThread,
} from "./templates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from script root.
const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) {
  loadDotenv({ path: envPath });
}

interface Args {
  command: string;
  dryRun: boolean;
  stockCode?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    dryRun: process.env.TWITTER_DRY_RUN_DEFAULT !== "false",
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--live") args.dryRun = false;
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
  switch (command) {
    case "daily-shorts": {
      const text = await buildDailyShortsTweet();
      await client.postTweet(text);
      break;
    }
    case "movers": {
      const text = await buildMoversTweet();
      await client.postTweet(text);
      break;
    }
    case "stock-of-the-day": {
      const text = await buildStockOfTheDayTweet();
      await client.postTweet(text);
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
  const client = createClient({ dryRun: args.dryRun });

  try {
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
