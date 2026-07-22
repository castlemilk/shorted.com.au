// Economy state-banner backgrounds — direct OpenAI Images generator.
//
// Cloned from the proven housing banner generator. Raw 1536x1024 masters are
// kept under ignored ./out; reruns skip completed states unless FORCE=1.
//
// Usage:
//   export OPENAI_API_KEY=... # never print it
//   node web/scripts/economy-banners/generate-backgrounds-openai.mjs
//   ONLY=wa,qld CONCURRENCY=2 node web/scripts/economy-banners/generate-backgrounds-openai.mjs
import {
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STYLE, ARCHETYPES } from "./banner-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error("OPENAI_API_KEY not set");
  process.exit(1);
}

const MODEL = process.env.MODEL || "gpt-image-1";
const SIZE = process.env.SIZE || "1536x1024";
const QUALITY = process.env.QUALITY || "medium";
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const FORCE = process.env.FORCE === "1";
const ONLY = process.env.ONLY
  ? new Set(process.env.ONLY.split(",").map((value) => value.trim()))
  : null;
const ESTIMATED_COST_PER_IMAGE_USD = Number(
  process.env.ESTIMATED_COST_PER_IMAGE_USD || 0.063,
);

let todo = ARCHETYPES.filter(({ id }) => (ONLY ? ONLY.has(id) : true));
if (!FORCE) {
  todo = todo.filter(({ id }) => !existsSync(join(OUT, `${id}.png`)));
}
if (todo.length === 0) {
  console.error("Nothing to generate (set FORCE=1 to regenerate). ");
  process.exit(0);
}

console.error(
  `model=${MODEL} size=${SIZE} quality=${QUALITY} scenes=${todo.length}/${ARCHETYPES.length}`,
);

async function generate(archetype) {
  const prompt = `${archetype.subject}. ${STYLE.suffix}`;
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      size: SIZE,
      quality: QUALITY,
      n: 1,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `HTTP ${response.status}`);
  }

  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error("no image data in response");

  const target = join(OUT, `${archetype.id}.png`);
  const partial = `${target}.partial`;
  writeFileSync(partial, Buffer.from(b64, "base64"));
  renameSync(partial, target);
  return { id: archetype.id, ok: true, usage: body?.usage };
}

const results = [];
const queue = [...todo];
async function worker() {
  while (queue.length > 0) {
    const archetype = queue.shift();
    const startedAt = Date.now();
    try {
      const result = await generate(archetype);
      console.error(
        `  ✓ ${archetype.id} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
      );
      results.push(result);
    } catch (error) {
      console.error(`  ✗ ${archetype.id}: ${error.message}`);
      results.push({ id: archetype.id, ok: false, error: error.message });
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker),
);

const ok = results.filter((result) => result.ok).length;
const summary = {
  model: MODEL,
  size: SIZE,
  quality: QUALITY,
  requested: todo.length,
  generated: ok,
  estimatedCostPerImageUsd: ESTIMATED_COST_PER_IMAGE_USD,
  estimatedSpendUsd: Number((ok * ESTIMATED_COST_PER_IMAGE_USD).toFixed(3)),
  results,
};
writeFileSync(
  join(OUT, "_run-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.error(
  `\nDONE ${ok}/${todo.length} saved -> ${OUT} (estimated spend $${summary.estimatedSpendUsd.toFixed(3)} USD)`,
);

if (ok !== todo.length) process.exitCode = 1;
