// Politics iconography — the PROVEN direct-OpenAI generation path.
//
// Calls the OpenAI Images API (gpt-image-1) directly with a transparent
// background, one request per icon, and writes ./out/<id>.png. Cloned from
// web/scripts/economy-icons/generate-icons-openai.mjs. Resumable: an icon whose
// out/<id>.png already exists is skipped unless FORCE=1.
//
// The prompt is `${subject}. ${STYLE.suffix}` plus an explicit "Do NOT include:"
// line built from STYLE.negativeConstraints. The negatives are not decoration —
// they carry the editorial bans (no money, no warning, no gavel, no trophy) into
// the request itself, because the model WILL decorate a parcel with a currency
// symbol if nothing tells it not to.
//
// EVERY GENERATED PNG MUST BE INSPECTED BEFORE PACKING. The prompt reduces the
// odds of banned imagery; it does not eliminate them. Open the files, and
// regenerate any that came back with money, a warning mark, a gavel, scales or a
// trophy — with the offending element named in a tightened subject:
//
//   ONLY=gifts FORCE=1 node web/scripts/politics-icons/generate-icons-openai.mjs
//
// Usage:
//   OPENAI_API_KEY=… node web/scripts/politics-icons/generate-icons-openai.mjs
//   ONLY=gifts,trusts node .../generate-icons-openai.mjs   # subset
//   FORCE=1 node .../generate-icons-openai.mjs             # regen even if present
//
// Env:
//   OPENAI_API_KEY  (required)  — read-only from ~/projects/shorted/services/.env
//   QUALITY=low|medium|high  (default medium)   SIZE (default 1024x1024)
//   ONLY=comma,ids   FORCE=1   CONCURRENCY (default 3)   DELAY_MS (default 400)
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STYLE, ICONS } from "./icon-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const API_KEY = process.env.OPENAI_API_KEY?.trim();
if (!API_KEY) {
  console.error("OPENAI_API_KEY is required (read-only from ~/projects/shorted/services/.env).");
  process.exit(1);
}
const QUALITY = process.env.QUALITY || "medium";
const SIZE = process.env.SIZE || "1024x1024";
const FORCE = process.env.FORCE === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const DELAY_MS = Number(process.env.DELAY_MS || 400);

const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NEGATIVES = `Do NOT include: ${STYLE.negativeConstraints.join(", ")}.`;

let todo = ICONS.filter((ic) => (ONLY ? ONLY.has(ic.id) : true));
if (!FORCE) todo = todo.filter((ic) => !existsSync(join(OUT, `${ic.id}.png`)));
if (todo.length === 0) {
  log("Nothing to generate (all present; set FORCE=1 to regenerate).");
  process.exit(0);
}
log(`gpt-image-1 quality=${QUALITY} size=${SIZE} icons=${todo.length}/${ICONS.length} concurrency=${CONCURRENCY}`);

async function generateOne(ic, attempt = 1) {
  const prompt = `${ic.subject}. ${STYLE.suffix} ${NEGATIVES}`;
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      n: 1,
      size: SIZE,
      quality: QUALITY,
      background: "transparent",
      output_format: "png",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Retry transient rate-limit / server errors with backoff.
    if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
      const wait = 2000 * attempt;
      log(`  ${ic.id}: HTTP ${res.status}, retry ${attempt} in ${wait}ms`);
      await sleep(wait);
      return generateOne(ic, attempt + 1);
    }
    throw new Error(`${ic.id}: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${ic.id}: no b64_json in response`);
  writeFileSync(join(OUT, `${ic.id}.png`), Buffer.from(b64, "base64"));
  const usage = json.usage ? ` tokens=${json.usage.total_tokens}` : "";
  log(`  ✓ ${ic.id}${usage}`);
  return ic.id;
}

// Small concurrency pool, polite delay between kickoffs.
const results = { saved: [], failed: [] };
const queue = [...todo];
async function worker() {
  while (queue.length) {
    const ic = queue.shift();
    try {
      await generateOne(ic);
      results.saved.push(ic.id);
    } catch (e) {
      log(`  ✗ ${e.message}`);
      results.failed.push(ic.id);
    }
    await sleep(DELAY_MS);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker()));

writeFileSync(join(OUT, "_run-summary.json"), JSON.stringify(results, null, 2));
log(`\nDONE saved=${results.saved.length}/${todo.length} failed=${results.failed.length} -> ${OUT}`);
log("NEXT: open every PNG and check it against the bans in icon-set.config.mjs before packing.");
if (results.failed.length) {
  log(`failed: ${results.failed.join(", ")} (re-run to resume — present icons are skipped)`);
  process.exit(1);
}
