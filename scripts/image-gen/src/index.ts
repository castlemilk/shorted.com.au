#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import OpenAI from "openai";

import { buildImagePrompt, imageSizeFor, type PromptInput } from "./brand-prompt.js";
import { generateImage } from "./openai-image.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env from local script, repo .env, and services/.env (where the
// existing OPENAI_API_KEY and GEMINI_API_KEY already live).
const candidates = [
  resolve(__dirname, "..", ".env"),
  resolve(__dirname, "..", "..", "..", ".env"),
  resolve(__dirname, "..", "..", "..", "services", ".env"),
];
for (const p of candidates) {
  if (existsSync(p)) loadDotenv({ path: p, override: false });
}

type Quality = "low" | "medium" | "high" | "auto";

interface Args {
  command: string;
  topic?: string;
  type: PromptInput["type"];
  out?: string;
  quality: Quality;
  additionalContext?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    type: "hero",
    quality: "medium",
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--topic=")) args.topic = arg.split("=").slice(1).join("=");
    else if (arg.startsWith("--type=")) {
      const v = arg.split("=")[1];
      if (v === "hero" || v === "thumbnail" || v === "inline") args.type = v;
    } else if (arg.startsWith("--out=")) args.out = arg.split("=")[1];
    else if (arg.startsWith("--quality=")) {
      const v = arg.split("=")[1];
      if (v === "low" || v === "medium" || v === "high" || v === "auto") args.quality = v;
    } else if (arg.startsWith("--context=")) {
      args.additionalContext = arg.split("=").slice(1).join("=");
    } else if (!arg.startsWith("--") && !args.command) args.command = arg;
  }
  return args;
}

function printHelp(): void {
  console.log(`
@shorted/image-gen — editorial image generator

Commands:
  generate    Create a single image from a topic + type
  plan        (TODO) Use Gemini to plan assets needed for an article
  upload      (TODO) Upload a local PNG to GCS shorted-company-logos/takes/
  pipeline    (TODO) Plan + generate + upload, end-to-end

generate flags:
  --topic="..."         (required) editorial subject of the image
  --type=hero           hero|thumbnail|inline (default: hero)
  --out=/tmp/x.png      output path; if omitted, prints stats only
  --quality=medium      low|medium|high|auto (default: medium, ~$0.04-0.06)
  --context="..."       optional extra prompt context

Examples:
  tsx src/index.ts generate \\
    --topic="Lotus Resources rare earths processing plant in Western Australia" \\
    --type=hero \\
    --out=/tmp/lot-hero.png
`);
}

async function runGenerate(args: Args): Promise<void> {
  if (!args.topic) {
    throw new Error("--topic=\"...\" is required for generate");
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY not set (looked in .env, repo .env, services/.env)");
  }
  const client = new OpenAI({ apiKey: key });

  const prompt = buildImagePrompt({
    topic: args.topic,
    type: args.type,
    additionalContext: args.additionalContext,
  });
  const size = imageSizeFor(args.type);

  console.log(`[image-gen] type=${args.type} size=${size} quality=${args.quality}`);
  console.log(`[image-gen] prompt (first 200 chars):\n${prompt.slice(0, 200)}…\n`);

  const t0 = Date.now();
  const result = await generateImage(client, {
    prompt,
    size,
    quality: args.quality,
    n: 1,
  }, args.out);
  const ms = Date.now() - t0;

  console.log(`[image-gen] done in ${ms}ms`);
  console.log(`[image-gen] bytes=${result.pngBuffer.length}`);
  console.log(`[image-gen] estimated cost=$${result.estimatedCostUsd.toFixed(4)}`);
  if (args.out) {
    console.log(`[image-gen] wrote → ${args.out}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  switch (args.command) {
    case "generate":
      await runGenerate(args);
      break;
    case "plan":
    case "upload":
    case "pipeline":
      console.error(`[image-gen] '${args.command}' not yet implemented — see task list`);
      process.exit(2);
    default:
      console.error(`[image-gen] unknown command: ${args.command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[image-gen] failed:", err.message ?? err);
  process.exit(1);
});
