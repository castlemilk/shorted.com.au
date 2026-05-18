#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import OpenAI from "openai";

import { readFileSync } from "node:fs";
import { buildImagePrompt, imageSizeFor, type PromptInput } from "./brand-prompt.js";
import { generateImage } from "./openai-image.js";
import { planAssets, type PlanInput } from "./planner.js";
import { uploadPng } from "./gcs-upload.js";

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
  model?: string;
  additionalContext?: string;
  help: boolean;
  // plan
  headline?: string;
  bodyFile?: string;
  bodyText?: string;
  stockCode?: string;
  sentiment?: string;
  // upload
  file?: string;
  slug?: string;
  inlineIndex?: number;
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
    } else if (arg.startsWith("--model=")) {
      args.model = arg.split("=").slice(1).join("=");
    } else if (arg.startsWith("--context=")) {
      args.additionalContext = arg.split("=").slice(1).join("=");
    } else if (arg.startsWith("--headline=")) {
      args.headline = arg.split("=").slice(1).join("=");
    } else if (arg.startsWith("--body-file=")) {
      args.bodyFile = arg.split("=").slice(1).join("=");
    } else if (arg.startsWith("--body=")) {
      args.bodyText = arg.split("=").slice(1).join("=");
    } else if (arg.startsWith("--stock=")) {
      args.stockCode = arg.split("=")[1];
    } else if (arg.startsWith("--sentiment=")) {
      args.sentiment = arg.split("=")[1];
    } else if (arg.startsWith("--file=")) {
      args.file = arg.split("=").slice(1).join("=");
    } else if (arg.startsWith("--slug=")) {
      args.slug = arg.split("=")[1];
    } else if (arg.startsWith("--inline-index=")) {
      const v = arg.split("=")[1];
      if (v !== undefined) args.inlineIndex = parseInt(v, 10);
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

  console.log(`[image-gen] model=${args.model ?? "gpt-image-1"} type=${args.type} size=${size} quality=${args.quality}`);
  console.log(`[image-gen] prompt (first 200 chars):\n${prompt.slice(0, 200)}…\n`);

  const t0 = Date.now();
  const result = await generateImage(client, {
    prompt,
    size,
    quality: args.quality,
    n: 1,
    model: args.model,
  }, args.out);
  const ms = Date.now() - t0;

  console.log(`[image-gen] done in ${ms}ms`);
  console.log(`[image-gen] bytes=${result.pngBuffer.length}`);
  console.log(`[image-gen] estimated cost=$${result.estimatedCostUsd.toFixed(4)}`);
  if (args.out) {
    console.log(`[image-gen] wrote → ${args.out}`);
  }
}

async function runPlan(args: Args): Promise<void> {
  if (!args.headline) {
    throw new Error("--headline=\"...\" is required for plan");
  }
  let body = args.bodyText;
  if (!body && args.bodyFile) body = readFileSync(args.bodyFile, "utf8");
  if (!body) {
    throw new Error("provide either --body=\"...\" or --body-file=path.md");
  }
  const input: PlanInput = {
    headline: args.headline,
    bodyMd: body,
    stockCode: args.stockCode,
    sentiment: args.sentiment,
  };
  console.log(`[image-gen] planning assets for: ${args.headline}`);
  const plan = await planAssets(input);
  console.log(JSON.stringify(plan, null, 2));
}

interface PipelineResult {
  slug: string;
  hero?: { type: "hero"; topic: string; publicUrl: string; bytes: number; estimatedCostUsd: number };
  thumbnail?: { type: "thumbnail"; topic: string; publicUrl: string; bytes: number; estimatedCostUsd: number };
  inline: Array<{ type: "inline"; topic: string; publicUrl: string; bytes: number; estimatedCostUsd: number }>;
  totalCostUsd: number;
}

async function runPipeline(args: Args): Promise<void> {
  if (!args.headline) throw new Error("--headline=\"...\" required for pipeline");
  if (!args.slug) throw new Error("--slug=... required for pipeline");
  let body = args.bodyText;
  if (!body && args.bodyFile) body = readFileSync(args.bodyFile, "utf8");
  if (!body) throw new Error("provide --body=\"...\" or --body-file=path.md");

  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const openai = new OpenAI({ apiKey: key });

  console.log(`[pipeline] planning assets for: ${args.headline}`);
  const plan = await planAssets({
    headline: args.headline,
    bodyMd: body,
    stockCode: args.stockCode,
    sentiment: args.sentiment,
  });
  console.log(`[pipeline] planner returned ${plan.length} asset(s)`);

  const result: PipelineResult = { slug: args.slug, inline: [], totalCostUsd: 0 };
  let inlineCount = 0;

  for (const asset of plan) {
    const inlineIdx = asset.type === "inline" ? inlineCount++ : undefined;
    console.log(`[pipeline] generate ${asset.type}${inlineIdx !== undefined ? `[${inlineIdx}]` : ""}: ${asset.topic.slice(0, 80)}…`);

    const prompt = buildImagePrompt({ topic: asset.topic, type: asset.type });
    const gen = await generateImage(openai, {
      prompt,
      size: imageSizeFor(asset.type),
      quality: args.quality,
      model: args.model,
    });
    console.log(`[pipeline]   generated: $${gen.estimatedCostUsd.toFixed(4)} ${gen.pngBuffer.length}b`);

    const up = await uploadPng({
      buffer: gen.pngBuffer,
      slug: args.slug,
      type: asset.type,
      inlineIndex: inlineIdx,
    });
    console.log(`[pipeline]   uploaded: ${up.publicUrl}`);

    const entry = {
      type: asset.type,
      topic: asset.topic,
      publicUrl: up.publicUrl,
      bytes: gen.pngBuffer.length,
      estimatedCostUsd: gen.estimatedCostUsd,
    };
    result.totalCostUsd += gen.estimatedCostUsd;
    if (asset.type === "hero") result.hero = entry as PipelineResult["hero"];
    else if (asset.type === "thumbnail") result.thumbnail = entry as PipelineResult["thumbnail"];
    else result.inline.push(entry as PipelineResult["inline"][number]);
  }

  console.log("");
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n[pipeline] total cost: $${result.totalCostUsd.toFixed(4)}`);
}

async function runUpload(args: Args): Promise<void> {
  if (!args.file) throw new Error("--file=path.png is required for upload");
  if (!args.slug) throw new Error("--slug=... is required for upload");
  const validTypes = ["hero", "thumbnail", "inline"] as const;
  if (!validTypes.includes(args.type)) {
    throw new Error(`--type must be one of: ${validTypes.join("|")}`);
  }
  console.log(`[image-gen] uploading ${args.file} → takes/${args.slug}-${args.type}.png`);
  const result = await uploadPng({
    filePath: args.file,
    slug: args.slug,
    type: args.type,
    inlineIndex: args.inlineIndex,
  });
  console.log(JSON.stringify(result, null, 2));
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
      await runPlan(args);
      break;
    case "upload":
      await runUpload(args);
      break;
    case "pipeline":
      await runPipeline(args);
      break;
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
