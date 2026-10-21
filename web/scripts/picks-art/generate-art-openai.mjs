// Stock picker editorial art: the DIRECT OpenAI fallback.
//
// The brandbrain flow (generate-art.mjs) is the intended path. When its MCP
// is not built or not logged in, this draws the SAME scenes from the SAME
// config through the Images API, as the housing sets' fallbacks do: set
// consistency comes from the shared style suffix, not from the flow.
//
// Usage:
//   export OPENAI_API_KEY=...        # never print it
//   node web/scripts/picks-art/generate-art-openai.mjs
//   ONLY=canslim node web/scripts/picks-art/generate-art-openai.mjs
//   FORCE=1 node web/scripts/picks-art/generate-art-openai.mjs
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STYLE, SCENES } from "./art-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error("OPENAI_API_KEY not set");
  process.exit(1);
}
const MODEL = process.env.MODEL || "gpt-image-1";
const SIZE = process.env.SIZE || "1536x1024"; // the 3:2 master the bake script crops
const QUALITY = process.env.QUALITY || "medium";
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const FORCE = process.env.FORCE === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;

let todo = SCENES.filter((s) => (ONLY ? ONLY.has(s.id) : true));
if (!FORCE) todo = todo.filter((s) => !existsSync(join(OUT, `${s.id}.png`)));
if (todo.length === 0) {
  console.error("Nothing to generate (set FORCE=1 to regenerate).");
  process.exit(0);
}
console.error(`model=${MODEL} size=${SIZE} quality=${QUALITY} scenes=${todo.length}/${SCENES.length}`);

async function generate(scene) {
  const prompt = `${scene.subject}. ${STYLE.suffix}`;
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, prompt, size: SIZE, quality: QUALITY, n: 1 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error("no image data in response");
  writeFileSync(join(OUT, `${scene.id}.png`), Buffer.from(b64, "base64"));
  return scene.id;
}

const queue = [...todo];
const saved = [];
const failed = [];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const scene = queue.shift();
      try {
        saved.push(await generate(scene));
        console.error(`  saved ${scene.id}`);
      } catch (e) {
        failed.push(scene.id);
        console.error(`  FAILED ${scene.id}: ${e.message}`);
      }
    }
  }),
);
console.error(`DONE saved=${saved.length} failed=${failed.length} -> ${OUT}`);
if (failed.length) process.exit(1);
