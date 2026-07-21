// Economy iconography — the alternative flow-orchestrator (brandbrain MCP) path.
// Clone of web/scripts/economy-icons/generate-icons.mjs. The DIRECT path
// (generate-icons-openai.mjs) is the proven route used for the shipped set;
// this exists for parity and requires brandbrain backend auth (whoami/login).
//
// Drives the brandbrain `flow-orchestrator` MCP server over one persistent stdio
// connection (the polling task registry is per-process). For each batch of icons
// it: creates a flow session → builds a graph (one shared `style` node fanning
// into per-icon prompt→generate→output chains) → validates → runs → saves each
// output PNG to ./out/<id>.png.
//
// Per-component prompts + shared style live in icon-set.config.mjs. This script
// is the "flow": inputs = per-component prompts, output = the icon set.
//
// Usage:
//   MODE=live node web/scripts/economy-icons/generate-icons.mjs            # all icons
//   MODE=mock node .../generate-icons.mjs                                  # dry structure, no spend
//   MODE=live ONLY=median-price,school node .../generate-icons.mjs         # subset
//   FORCE=1 MODE=live node .../generate-icons.mjs                          # regen even if PNG exists
//
// Env:
//   MODE=mock|live (default mock — live must be explicit; live spends on the backend)
//   BATCH_SIZE (default 8)   BRANDBRAIN_API_URL (default prod)   BRANDBRAIN_APP_URL (default prod)
//   FLOW_MCP_ENTRY (default the local brandbrain flow-orchestrator dist/index.js)
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { STYLE, ICONS } from "./icon-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const MODE = process.env.MODE === "live" ? "live" : "mock";
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 8);
const FORCE = process.env.FORCE === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;
const FLOW_MCP_ENTRY =
  process.env.FLOW_MCP_ENTRY ||
  "/Users/benebsworth/projects/brandbrain/mcp/flow-orchestrator/dist/index.js";
const API_URL = process.env.BRANDBRAIN_API_URL || "https://api.brandbrain.dev";
const APP_URL = process.env.BRANDBRAIN_APP_URL || "https://brandbrain.dev";

const log = (...a) => console.error(...a);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// Which icons still need generating.
let todo = ICONS.filter((ic) => (ONLY ? ONLY.has(ic.id) : true));
if (!FORCE) todo = todo.filter((ic) => !existsSync(join(OUT, `${ic.id}.png`)));
if (todo.length === 0) {
  log("Nothing to generate (all present; set FORCE=1 to regenerate).");
  process.exit(0);
}
log(`MODE=${MODE} icons=${todo.length}/${ICONS.length} batches=${Math.ceil(todo.length / BATCH_SIZE)} api=${API_URL}`);

const transport = new StdioClientTransport({
  command: "node",
  args: [FLOW_MCP_ENTRY],
  env: { ...process.env, BRANDBRAIN_API_URL: API_URL, BRANDBRAIN_APP_URL: APP_URL },
});
const client = new Client({ name: "economy-icons", version: "1.0.0" });
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
  for (const ic of batch) {
    ops.push({ op: "add_node", type: "prompt", id: `p_${ic.id}`, text: `${ic.subject}. ${STYLE.suffix}`, label: ic.id });
    ops.push({ op: "add_node", type: "generate", id: `g_${ic.id}`, provider: "openai", modelId: "gpt-image-1", strategy: "direct" });
    ops.push({ op: "add_node", type: "output", id: `o_${ic.id}` });
    ops.push({ op: "connect", sourceNodeId: "style", targetNodeId: `g_${ic.id}` });
    ops.push({ op: "connect", sourceNodeId: `p_${ic.id}`, targetNodeId: `g_${ic.id}` });
    ops.push({ op: "connect", sourceNodeId: `g_${ic.id}`, targetNodeId: `o_${ic.id}` });
    ops.push({
      op: "set_generate_target", nodeId: `g_${ic.id}`, surface: "app icon", aspectRatio: "1:1",
      textPolicy: "GENERATE_TEXT_POLICY_DISALLOW",
      compositionRules: ["single centred icon subject", "generous even padding", "no scene or background"],
      copySafety: "no headline space needed",
    });
  }
  return ops;
}

async function runBatch(batch, idx) {
  const created = sc(await call("create_asset_flow", {
    title: `Shorted Economy Icons — batch ${idx + 1}`,
    goal: "cohesive warm-duotone icon set for the economy data view",
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
  if (status !== "completed") { log(`    batch ${idx + 1} status=${status} err=${run?.error ?? "?"}`); }

  // report per-node status
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
    const path = join(OUT, `${id}.png`);
    writeFileSync(path, Buffer.from(images[k].data, "base64"));
    saved.push(id);
  }
  log(`    saved ${saved.length}: ${saved.join(", ")}`);
  return { sessionId, runId, saved, cost: run?.total_cost_usd };
}

const results = [];
try {
  const who = sc(await call("whoami_brandbrain", {}));
  if (!who.authenticated) throw new Error("not authenticated — run `login_brandbrain` (smoke.mjs login) first");
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
writeFileSync(join(OUT, "_run-summary.json"), JSON.stringify({ mode: MODE, saved: savedAll, results }, null, 2));
log(`\nDONE mode=${MODE} saved=${savedAll.length}/${todo.length} cost~=$${totalCost.toFixed(3)} -> ${OUT}`);
