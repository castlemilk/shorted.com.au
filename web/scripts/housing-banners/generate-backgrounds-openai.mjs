// Housing suburb-banner backgrounds — DIRECT OpenAI fallback generator.
//
// The brandbrain flow-orchestrator MCP is the intended production pipeline, but
// its local build has drifted behind the deployed "asset-set" canvas backend
// (validation now rejects the old topology). Since the flow is only a wrapper
// around OpenAI gpt-image-1 — and per the icon-flow notes, set consistency comes
// from the shared style-suffix alone — this script produces the SAME look by
// calling the Images API directly. Used to generate review samples; the config
// (banner-set.config.mjs) is shared with the MCP generator, so nothing is wasted.
//
// Usage:
//   export OPENAI_API_KEY=...   # (do not print it)
//   node web/scripts/housing-banners/generate-backgrounds-openai.mjs
//   ONLY=coastal-beach,harbour SIZE=1536x1024 QUALITY=high node .../generate-backgrounds-openai.mjs
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STYLE, ARCHETYPES } from "./banner-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error("OPENAI_API_KEY not set"); process.exit(1); }
const MODEL = process.env.MODEL || "gpt-image-1";
const SIZE = process.env.SIZE || "1536x1024"; // widest gpt-image-1 landscape (3:2)
const QUALITY = process.env.QUALITY || "medium";
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const FORCE = process.env.FORCE === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;

let todo = ARCHETYPES.filter((a) => (ONLY ? ONLY.has(a.id) : true));
if (!FORCE) todo = todo.filter((a) => !existsSync(join(OUT, `${a.id}.png`)));
if (todo.length === 0) { console.error("Nothing to generate (set FORCE=1 to regen)."); process.exit(0); }
console.error(`model=${MODEL} size=${SIZE} quality=${QUALITY} scenes=${todo.length}/${ARCHETYPES.length}`);

async function generate(a) {
  const prompt = `${a.subject}. ${STYLE.suffix}`;
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, prompt, size: SIZE, quality: QUALITY, n: 1 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error("no image data in response");
  writeFileSync(join(OUT, `${a.id}.png`), Buffer.from(b64, "base64"));
  const usd = body?.usage ? undefined : undefined; // usage tokens not billed-priced here
  return { id: a.id, ok: true, usage: body?.usage };
}

// bounded concurrency
const results = [];
const queue = [...todo];
async function worker() {
  while (queue.length) {
    const a = queue.shift();
    const t0 = Date.now();
    try { const r = await generate(a); console.error(`  ✓ ${a.id} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); results.push(r); }
    catch (e) { console.error(`  ✗ ${a.id}: ${e.message}`); results.push({ id: a.id, ok: false, error: e.message }); }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

writeFileSync(join(OUT, "_run-summary.json"), JSON.stringify({ model: MODEL, size: SIZE, quality: QUALITY, results }, null, 2));
const ok = results.filter((r) => r.ok).length;
console.error(`\nDONE ${ok}/${todo.length} saved -> ${OUT}`);
