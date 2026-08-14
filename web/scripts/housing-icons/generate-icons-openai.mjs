// Housing icon set — DIRECT OpenAI fallback generator.
//
// The brandbrain flow-orchestrator MCP is the intended production pipeline, but
// its local build has drifted behind the deployed "asset-set" canvas backend
// (validation now rejects the old topology). Since the flow is only a wrapper
// around OpenAI gpt-image-1 — and set consistency comes from the shared
// style-suffix alone — this script produces the SAME look by calling the Images
// API directly. Mirrors web/scripts/housing-banners/generate-backgrounds-openai.mjs
// but targets the per-icon ICONS config (transparent, single-subject) instead of
// the full-bleed banner ARCHETYPES scenes.
//
// Usage:
//   export OPENAI_API_KEY=...   # (do not print it)
//   node web/scripts/housing-icons/generate-icons-openai.mjs
//   ONLY=coastal-beach,harbour node web/scripts/housing-icons/generate-icons-openai.mjs
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STYLE, ICONS } from "./icon-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error("OPENAI_API_KEY not set"); process.exit(1); }
const MODEL = process.env.MODEL || "gpt-image-1";
const SIZE = process.env.SIZE || "1024x1024"; // square icon cell
const QUALITY = process.env.QUALITY || "medium";
const BACKGROUND = process.env.BACKGROUND || "transparent";
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const FORCE = process.env.FORCE === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;

let todo = ICONS.filter((i) => (ONLY ? ONLY.has(i.id) : true));
if (!FORCE) todo = todo.filter((i) => !existsSync(join(OUT, `${i.id}.png`)));
if (todo.length === 0) { console.error("Nothing to generate (set FORCE=1 to regen)."); process.exit(0); }
console.error(`model=${MODEL} size=${SIZE} quality=${QUALITY} background=${BACKGROUND} icons=${todo.length}/${ICONS.length}`);

async function generate(icon) {
  const prompt = `${icon.subject}. ${STYLE.suffix}`;
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, prompt, size: SIZE, quality: QUALITY, background: BACKGROUND, n: 1 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error("no image data in response");
  writeFileSync(join(OUT, `${icon.id}.png`), Buffer.from(b64, "base64"));
  return { id: icon.id, ok: true, usage: body?.usage };
}

// bounded concurrency
const results = [];
const queue = [...todo];
async function worker() {
  while (queue.length) {
    const icon = queue.shift();
    const t0 = Date.now();
    try { const r = await generate(icon); console.error(`  ✓ ${icon.id} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); results.push(r); }
    catch (e) { console.error(`  ✗ ${icon.id}: ${e.message}`); results.push({ id: icon.id, ok: false, error: e.message }); }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

writeFileSync(join(OUT, "_run-summary-icons.json"), JSON.stringify({ model: MODEL, size: SIZE, quality: QUALITY, background: BACKGROUND, results }, null, 2));
const ok = results.filter((r) => r.ok).length;
console.error(`\nDONE ${ok}/${todo.length} saved -> ${OUT}`);
