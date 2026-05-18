#!/usr/bin/env node
/**
 * Pre-post copy lint for @shorted___.
 *
 * Greps a tweet/Take draft for the banned phrases from CHECKLIST.md HARD
 * gates and flags sentence-length monotony from SOFT gate 8. Exits 1 if
 * any HARD gate fails so it can be wired into git hooks or a `--check`
 * flag on the bot CLI.
 *
 * Usage:
 *   node scripts/twitter/scripts/lint-copy.mjs --text "<paste here>"
 *   node scripts/twitter/scripts/lint-copy.mjs --file path/to/draft.md
 *   echo "draft" | node scripts/twitter/scripts/lint-copy.mjs --stdin
 */

import { readFileSync } from "node:fs";

const BANNED_PHRASES = [
  // AI-isms
  "dive in",
  "let's break it down",
  "delve",
  "delving",
  "here's what you need to know",
  "it's worth noting",
  "important to note",
  "it's important to remember",
  "in today's market",
  "in today's volatile",
  "navigating",
  "landscape",
  "unlock",
  "unleash",
  "leveraging",
  "robust",
  "comprehensive",
  "game-changer",
  "game changer",
  "at the end of the day",
  "circle back",
  "level up",
  "moreover",
  "furthermore",
  "in conclusion",
  "stay tuned",
  "exciting times",
  "what are your thoughts",
  "let me know in the comments",
  "drop your thoughts",
  "diamond hands",
  "to the moon",
  "fascinating",
  "compelling story",
  "unpack",
  "tell a story",
  "the data tells",
  "paints a picture",
  // Finance clichés (SOFT — warned but not fatal)
];

const SOFT_CLICHES = [
  "rollercoaster",
  "wild ride",
  "bears vs bulls",
  "blood in the streets",
  "smart money",
  "dumb money",
  "catching a falling knife",
];

const THROAT_CLEARING_OPENERS = [
  /^today'?s most/i,
  /^here are/i,
  /^here'?s/i,
  /^looking at/i,
  /^the top/i,
  /^welcome to/i,
  /^let'?s /i,
  /^did you know/i,
  /^have you ever/i,
  /^are you/i,
  /^want to know/i,
];

const BANNED_EMOJI = ["🚀", "💎", "🙌"];

const CTA_PATTERNS = [
  /follow us/i,
  /click here/i,
  /dm us/i,
  /share if you agree/i,
  /\brt if/i,
  /tag a friend/i,
  /like \+ retweet/i,
  /what do you think\?/i,
];

function parseArgs(argv) {
  const out = { text: null, file: null, stdin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text") out.text = argv[++i];
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--stdin") out.stdin = true;
  }
  return out;
}

async function getInput(args) {
  if (args.text) return args.text;
  if (args.file) return readFileSync(args.file, "utf8");
  if (args.stdin) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Pass --text, --file, or --stdin");
}

function lint(text) {
  const issues = { hard: [], soft: [] };
  const lower = text.toLowerCase();

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      issues.hard.push(`banned phrase: "${phrase}"`);
    }
  }

  for (const cliche of SOFT_CLICHES) {
    if (lower.includes(cliche)) {
      issues.soft.push(`finance cliché: "${cliche}"`);
    }
  }

  const firstLine = text.trim().split(/\n/, 1)[0] ?? "";
  for (const rx of THROAT_CLEARING_OPENERS) {
    if (rx.test(firstLine)) {
      issues.hard.push(`throat-clearing opener: matches /${rx.source}/`);
      break;
    }
  }

  for (const e of BANNED_EMOJI) {
    if (text.includes(e)) issues.hard.push(`banned emoji: ${e}`);
  }

  for (const rx of CTA_PATTERNS) {
    if (rx.test(text)) {
      issues.hard.push(`CTA / engagement bait: /${rx.source}/`);
    }
  }

  const cashtags = (text.match(/\$[A-Z]{2,5}\b/g) || []).length;
  if (cashtags > 1) {
    issues.hard.push(`${cashtags} cashtags — X limit is 1 per post`);
  }

  const hasSpecific =
    /\$?[A-Z]{2,5}\b/.test(text) ||
    /\d+(\.\d+)?\s?%/.test(text) ||
    /\$\d+(\.\d+)?[BMK]?\b/i.test(text);
  if (!hasSpecific) {
    issues.hard.push(
      "no specific ticker / percentage / dollar amount — too generic",
    );
  }

  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^https?:/.test(s) && !/^#/.test(s));
  if (sentences.length >= 3) {
    const wordCounts = sentences.map((s) => s.split(/\s+/).length);
    const hasShort = wordCounts.some((w) => w < 8);
    const hasLong = wordCounts.some((w) => w > 18);
    if (!(hasShort && hasLong)) {
      const min = Math.min(...wordCounts);
      const max = Math.max(...wordCounts);
      issues.soft.push(
        `sentence-length monotony: min=${min}w max=${max}w — need <8 AND >18`,
      );
    }
  }

  return issues;
}

function report(issues) {
  if (issues.hard.length === 0 && issues.soft.length === 0) {
    console.log("✓ lint clean");
    return 0;
  }
  if (issues.hard.length) {
    console.log("\n✗ HARD failures (rewrite required):");
    for (const i of issues.hard) console.log("  - " + i);
  }
  if (issues.soft.length) {
    console.log("\n⚠ SOFT warnings (consider rewriting):");
    for (const i of issues.soft) console.log("  - " + i);
  }
  console.log("");
  return issues.hard.length > 0 ? 1 : 0;
}

const args = parseArgs(process.argv.slice(2));
const text = await getInput(args);
process.exit(report(lint(text)));
