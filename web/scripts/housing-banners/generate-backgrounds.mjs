// Housing suburb-banner backgrounds — the generation flow.
//
// Drives the brandbrain `flow-orchestrator` MCP over ONE persistent stdio
// connection (the polling task registry is per-process). Builds a graph — one
// shared `style` node fanning into per-archetype prompt→generate→output chains —
// validates it, runs it, and saves each output PNG to ./out/<id>.png.
//
// These are the reusable archetype BACKGROUNDS; the per-suburb vector map + name
// are composited on top at render time (see the banner design spec).
//
// Usage:
//   MODE=mock node web/scripts/housing-banners/generate-backgrounds.mjs        # validate graph, no spend
//   MODE=live node web/scripts/housing-banners/generate-backgrounds.mjs        # generate (spends ~$0.06/img)
//   MODE=live ONLY=coastal-beach,harbour node .../generate-backgrounds.mjs     # subset
//   FORCE=1 MODE=live node .../generate-backgrounds.mjs                        # regen even if PNG exists
//
// Env:
//   MODE=mock|live (default mock)   BATCH_SIZE (default 10)   ASPECT (default 3:2)
//   FLOW_MCP_ENTRY   BRANDBRAIN_API_URL   BRANDBRAIN_APP_URL
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { STYLE, ARCHETYPES } from "./banner-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const MODE = process.env.MODE === "live" ? "live" : "mock";
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 10);
const ASPECT = process.env.ASPECT || "3:2";
const FORCE = process.env.FORCE === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;
const FLOW_MCP_ENTRY =
  process.env.FLOW_MCP_ENTRY ||
  "/Users/benebsworth/projects/brandbrain/mcp/flow-orchestrator/dist/index.js";
const API_URL = process.env.BRANDBRAIN_API_URL || "https://api.brandbrain.dev";
const APP_URL = process.env.BRANDBRAIN_APP_URL || "https://brandbrain.dev";

const log = (...a) => console.error(...a);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

let todo = ARCHETYPES.filter((a) => (ONLY ? ONLY.has(a.id) : true));
if (!FORCE) todo = todo.filter((a) => !existsSync(join(OUT, `${a.id}.png`)));
if (todo.length === 0) {
  log("Nothing to generate (all present; set FORCE=1 to regenerate).");
  process.exit(0);
}
log(`MODE=${MODE} aspect=${ASPECT} scenes=${todo.length}/${ARCHETYPES.length} batches=${Math.ceil(todo.length / BATCH_SIZE)} api=${API_URL}`);

const transport = new StdioClientTransport({
  command: "node",
  args: [FLOW_MCP_ENTRY],
  env: { ...process.env, BRANDBRAIN_API_URL: API_URL, BRANDBRAIN_APP_URL: APP_URL },
});
const client = new Client({ name: "housing-banners", version: "1.0.0" });
await client.connect(transport);

const callOpts = { timeout: 300000, resetTimeoutOnProgress: true };
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args ?? {} }, CallToolResultSchema, callOpts);
  if (res.isError) {
    const txt = (res.content ?? []).map((b) => b.text ?? "").join(" ");
    throw new Error(`tool ${name} error: ${txt || JSON.stringify(res).slice(0, 300)}`);
  }
  return res;
};
const sc = (res) => res.structuredContent ?? {};

function buildOps(batch) {
  const ops = [{
    op: "add_node", type: "style", id: "style",
    palette: STYLE.palette, themeStyle: STYLE.themeStyle,
    globalRules: STYLE.globalRules, negativeConstraints: STYLE.negativeConstraints,
  }];
  for (const a of batch) {
    ops.push({ op: "add_node", type: "prompt", id: `p_${a.id}`, text: `${a.subject}. ${STYLE.suffix}`, label: a.id });
    ops.push({ op: "add_node", type: "generate", id: `g_${a.id}`, provider: "openai", modelId: "gpt-image-1", strategy: "direct" });
    ops.push({ op: "add_node", type: "output", id: `o_${a.id}` });
    ops.push({ op: "connect", sourceNodeId: "style", targetNodeId: `g_${a.id}` });
    ops.push({ op: "connect", sourceNodeId: `p_${a.id}`, targetNodeId: `g_${a.id}` });
    ops.push({ op: "connect", sourceNodeId: `g_${a.id}`, targetNodeId: `o_${a.id}` });
    ops.push({
      op: "set_generate_target", nodeId: `g_${a.id}`, surface: "editorial hero banner background",
      aspectRatio: ASPECT, textPolicy: "GENERATE_TEXT_POLICY_DISALLOW",
      compositionRules: [
        "full-bleed landscape scene, no central clutter",
        "clean low horizon, scenery weighted to the lower two-thirds",
        "calm near-empty sky across the upper third",
      ],
      copySafety: "leave clear headline space across the upper-left for a suburb name and one stat",
    });
  }
  return ops;
}

async function runBatch(batch, idx) {
  const created = sc(await call("create_asset_flow", {
    title: `Shorted Housing Banners — batch ${idx + 1}`,
    goal: "cohesive warm-duotone editorial landscape backgrounds for suburb banner headers",
    flowSpec: { nodes: [], edges: [] },
  }));
  const sessionId = created.session?.id;
  log(`  session ${sessionId}`);
  const built = sc(await call("apply_flow_edits", { sessionId, ops: buildOps(batch) }));
  if (built.validation && built.validation.valid === false) throw new Error("invalid graph: " + JSON.stringify(built.validation.errors));

  const started = sc(await call("start_asset_flow_run", { sessionId, mode: MODE }));
  const taskId = started.task?.id;
  let status, runId, run;
  for (let i = 0; i < 300; i++) {
    const p = sc(await call("get_asset_flow_task", { taskId }));
    status = p.task?.status;
    if (i % 5 === 0 || status !== "working") log(`    poll ${i + 1}: ${status}`);
    if (status === "completed" || status === "failed") { run = p.run ?? {}; runId = run.id || run.run_id || p.task?.run_id; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (status !== "completed") log(`    batch ${idx + 1} status=${status} err=${run?.error ?? "?"}`);

  try {
    const trace = sc(await call("get_flow_trace", { sessionId, runId }));
    const bad = (trace.nodes || []).filter((n) => n.node_id?.startsWith("g_") && n.status !== "COMPLETED");
    if (bad.length) log(`    failed nodes: ${bad.map((n) => `${n.node_id}(${n.status}${n.error ? `:${n.error}` : ""})`).join(", ")}`);
  } catch { /* trace best-effort */ }

  const outRes = await call("get_flow_outputs", { sessionId, runId });
  const outputs = sc(outRes).outputs ?? [];
  const images = (outRes.content ?? []).filter((b) => b.type === "image");
  const saved = [];
  for (let k = 0; k < images.length; k++) {
    const nodeId = outputs[k]?.node_id || "";
    const id = nodeId.replace(/^o_/, "");
    if (!id) continue;
    writeFileSync(join(OUT, `${id}.png`), Buffer.from(images[k].data, "base64"));
    saved.push(id);
  }
  log(`    saved ${saved.length}: ${saved.join(", ")}`);
  return { sessionId, runId, saved, cost: run?.total_cost_usd };
}

const results = [];
try {
  const who = sc(await call("whoami_brandbrain", {}));
  if (!who.authenticated) throw new Error("not authenticated — run `login_brandbrain` (scripts/login.mjs) first");
  log(`auth: ${who.user?.email}`);
  const batches = chunk(todo, BATCH_SIZE);
  for (let i = 0; i < batches.length; i++) {
    log(`batch ${i + 1}/${batches.length} (${batches[i].map((b) => b.id).join(", ")})`);
    try { results.push(await runBatch(batches[i], i)); }
    catch (e) { log(`  batch ${i + 1} FAILED: ${e.message}`); results.push({ error: e.message }); }
  }
} finally {
  await client.close();
}

const savedAll = results.flatMap((r) => r.saved ?? []);
const totalCost = results.reduce((a, r) => a + (Number(r.cost) || 0), 0);
writeFileSync(join(OUT, "_run-summary.json"), JSON.stringify({ mode: MODE, aspect: ASPECT, saved: savedAll, results }, null, 2));
log(`\nDONE mode=${MODE} saved=${savedAll.length}/${todo.length} cost~=$${totalCost.toFixed(3)} -> ${OUT}`);
