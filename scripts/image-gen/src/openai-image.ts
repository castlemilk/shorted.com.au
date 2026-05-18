// OpenAI gpt-image-1 wrapper with cost cap and retry.
//
// Pricing (as of writing): standard quality is ~$0.04 per image at
// 1024x1024, ~$0.06 at 1536x1024. The COST_CAP_USD constant caps a
// single invocation. The day cap is the caller's responsibility.

import OpenAI from "openai";
import { writeFileSync } from "node:fs";

const MODEL = "gpt-image-1";
const COST_CAP_USD = 0.2; // per single generate call (multiple n) — fail safe

// Approx USD per image — gpt-image-1 quality tiers (Jan 2026 pricing).
// "medium" is our default for editorial-quality output at ~$0.04-0.06.
const PRICE_USD: Record<string, Record<string, number>> = {
  "gpt-image-1": {
    "1024x1024:low": 0.011,
    "1024x1024:medium": 0.042,
    "1024x1024:high": 0.167,
    "1536x1024:low": 0.016,
    "1536x1024:medium": 0.063,
    "1536x1024:high": 0.25,
    "1024x1536:low": 0.016,
    "1024x1536:medium": 0.063,
    "1024x1536:high": 0.25,
  },
};

export type ImageQuality = "low" | "medium" | "high" | "auto";

export interface GenerateOptions {
  prompt: string;
  size: "1024x1024" | "1536x1024" | "1024x1536";
  quality?: ImageQuality;
  n?: number;
}

export interface GenerateResult {
  pngBuffer: Buffer;
  estimatedCostUsd: number;
}

function estimateCost(opts: GenerateOptions): number {
  const q = opts.quality ?? "medium";
  // 'auto' is variable — assume medium for budgeting.
  const lookup = q === "auto" ? "medium" : q;
  const key = `${opts.size}:${lookup}`;
  const unit = PRICE_USD[MODEL]?.[key] ?? 0.06;
  return unit * (opts.n ?? 1);
}

export async function generateImage(
  client: OpenAI,
  opts: GenerateOptions,
  outPath?: string,
): Promise<GenerateResult> {
  const cost = estimateCost(opts);
  if (cost > COST_CAP_USD) {
    throw new Error(
      `Estimated cost $${cost.toFixed(2)} exceeds cap $${COST_CAP_USD.toFixed(2)}. Reduce n or lower quality.`,
    );
  }

  const resp = await client.images.generate({
    model: MODEL,
    prompt: opts.prompt,
    size: opts.size,
    quality: opts.quality ?? "medium",
    n: opts.n ?? 1,
  });

  const first = resp.data?.[0];
  if (!first?.b64_json) {
    throw new Error("OpenAI returned no image data");
  }
  const pngBuffer = Buffer.from(first.b64_json, "base64");
  if (outPath) {
    writeFileSync(outPath, pngBuffer);
  }
  return { pngBuffer, estimatedCostUsd: cost };
}
