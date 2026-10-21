// Stock picker editorial art: the generation flow, through the brandbrain
// flow-orchestrator MCP (web/scripts/lib/brandbrain-flow.mjs). Saves each
// scene's master PNG to ./out/<strategy-id>.png; bake.mjs turns those into
// the shipped AVIF bands, the share-card JPEGs and the manifest.
//
// Usage:
//   MODE=mock node web/scripts/picks-art/generate-art.mjs               # validate the graph, no spend
//   MODE=live node web/scripts/picks-art/generate-art.mjs               # generate (~$0.06 a scene)
//   MODE=live ONLY=canslim,zanger-breakout node .../generate-art.mjs    # a subset
//   FORCE=1 MODE=live node .../generate-art.mjs                         # regenerate masters that exist
//
// Env: MODE=mock|live (default mock)  BATCH_SIZE (default 5)  ASPECT (default 3:2)
//      FLOW_MCP_ENTRY  BRANDBRAIN_API_URL  BRANDBRAIN_APP_URL
//
// Without the MCP (or its login), generate-art-openai.mjs draws the same
// scenes from the same config through the Images API directly.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBrandbrainFlow } from "../lib/brandbrain-flow.mjs";
import { STYLE, SCENES, TARGET } from "./art-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const MODE = process.env.MODE === "live" ? "live" : "mock";
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 5);
const ASPECT = process.env.ASPECT || TARGET.aspectRatio;
const FORCE = process.env.FORCE === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;
const log = (...a) => console.error(...a);

let todo = SCENES.filter((s) => (ONLY ? ONLY.has(s.id) : true));
if (!FORCE) todo = todo.filter((s) => !existsSync(join(OUT, `${s.id}.png`)));
if (todo.length === 0) {
  log("Nothing to generate (all masters present; set FORCE=1 to regenerate).");
  process.exit(0);
}
log(`MODE=${MODE} aspect=${ASPECT} scenes=${todo.length}/${SCENES.length}`);

const { results, images } = await runBrandbrainFlow({
  clientName: "picks-art",
  title: "Shorted Stock Picker — strategy scenes",
  goal: "cohesive warm-duotone editorial scenes, one mechanism per strategy, for the picker's page headers and share cards",
  style: STYLE,
  items: todo,
  target: { ...TARGET, aspectRatio: ASPECT },
  mode: MODE,
  batchSize: BATCH_SIZE,
  log,
});

const saved = [];
for (const [id, png] of images) {
  writeFileSync(join(OUT, `${id}.png`), png);
  saved.push(id);
}
const totalCost = results.reduce((a, r) => a + (Number(r.cost) || 0), 0);
writeFileSync(join(OUT, "_run-summary.json"), JSON.stringify({ mode: MODE, aspect: ASPECT, saved, results }, null, 2));
log(`\nDONE mode=${MODE} saved=${saved.length}/${todo.length} cost~=$${totalCost.toFixed(3)} -> ${OUT}`);
if (MODE === "live" && saved.length < todo.length) process.exit(1);
