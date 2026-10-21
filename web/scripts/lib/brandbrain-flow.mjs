// The brandbrain `flow-orchestrator` MCP, driven from a script: ONE shared
// driver for every image set this repo generates through it.
//
// The housing icons and banners each carried their own copy of this loop
// (web/scripts/housing-icons/generate-icons.mjs, housing-banners/
// generate-backgrounds.mjs); this module is that loop once, so a new set
// (the picker art) is a config and a twenty-line script. It talks to the
// MCP over one persistent stdio connection (the polling task registry is
// per-process), builds a graph per batch (one shared `style` node fanning
// into per-item prompt -> generate -> output chains), validates it, runs it,
// polls the task, and hands back every output PNG.
//
// Nothing here writes files or reads the environment except through the
// options it is given, so a script decides where the art goes and a test can
// drive buildFlowOps without a server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

/** Where the MCP lives on the owner's machine; FLOW_MCP_ENTRY overrides it. */
export const DEFAULT_FLOW_MCP_ENTRY =
  "/Users/benebsworth/projects/brandbrain/mcp/flow-orchestrator/dist/index.js";
export const DEFAULT_API_URL = "https://api.brandbrain.dev";
export const DEFAULT_APP_URL = "https://brandbrain.dev";

/**
 * The graph for one batch, as apply_flow_edits ops: a `style` node carrying
 * the set's palette and rules, then per item a prompt, a generate node
 * (OpenAI gpt-image-1, direct), an output, and the edges between them, with
 * the generate target (surface, aspect, composition, copy safety) set last.
 *
 * `items` are `{ id, subject }`; the prompt is `${subject}. ${style.suffix}`.
 */
export function buildFlowOps({ style, items, target }) {
  const ops = [
    {
      op: "add_node",
      type: "style",
      id: "style",
      palette: style.palette,
      themeStyle: style.themeStyle,
      globalRules: style.globalRules,
      negativeConstraints: style.negativeConstraints,
    },
  ];
  for (const item of items) {
    ops.push({ op: "add_node", type: "prompt", id: `p_${item.id}`, text: `${item.subject}. ${style.suffix}`, label: item.id });
    ops.push({ op: "add_node", type: "generate", id: `g_${item.id}`, provider: "openai", modelId: "gpt-image-1", strategy: "direct" });
    ops.push({ op: "add_node", type: "output", id: `o_${item.id}` });
    ops.push({ op: "connect", sourceNodeId: "style", targetNodeId: `g_${item.id}` });
    ops.push({ op: "connect", sourceNodeId: `p_${item.id}`, targetNodeId: `g_${item.id}` });
    ops.push({ op: "connect", sourceNodeId: `g_${item.id}`, targetNodeId: `o_${item.id}` });
    ops.push({
      op: "set_generate_target",
      nodeId: `g_${item.id}`,
      surface: target.surface,
      aspectRatio: target.aspectRatio,
      textPolicy: target.textPolicy ?? "GENERATE_TEXT_POLICY_DISALLOW",
      compositionRules: target.compositionRules ?? [],
      copySafety: target.copySafety ?? "",
    });
  }
  return ops;
}

/** The output node id -> item id. */
export function itemIdOfOutput(nodeId) {
  return typeof nodeId === "string" && nodeId.startsWith("o_") ? nodeId.slice(2) : "";
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Connects to the MCP and generates every item, batch by batch. Resolves
 * with `{ results, images }`: `images` is a Map of item id -> PNG Buffer,
 * `results` one record per batch (session, run, saved ids, cost, or error).
 * `mode` "mock" validates and runs the graph without spending; "live"
 * generates on the backend (and costs money).
 */
export async function runBrandbrainFlow({
  clientName,
  title,
  goal,
  style,
  items,
  target,
  mode = "mock",
  batchSize = 8,
  entry = process.env.FLOW_MCP_ENTRY || DEFAULT_FLOW_MCP_ENTRY,
  apiUrl = process.env.BRANDBRAIN_API_URL || DEFAULT_API_URL,
  appUrl = process.env.BRANDBRAIN_APP_URL || DEFAULT_APP_URL,
  pollMs = 3000,
  pollLimit = 300,
  log = (...a) => console.error(...a),
}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [entry],
    env: { ...process.env, BRANDBRAIN_API_URL: apiUrl, BRANDBRAIN_APP_URL: appUrl },
  });
  const client = new Client({ name: clientName, version: "1.0.0" });
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

  const images = new Map();
  const results = [];

  async function runBatch(batch, idx) {
    const created = sc(await call("create_asset_flow", {
      title: `${title} — batch ${idx + 1}`,
      goal,
      flowSpec: { nodes: [], edges: [] },
    }));
    const sessionId = created.session?.id;
    log(`  session ${sessionId}`);
    const built = sc(await call("apply_flow_edits", { sessionId, ops: buildFlowOps({ style, items: batch, target }) }));
    if (built.validation && built.validation.valid === false) {
      throw new Error("invalid graph: " + JSON.stringify(built.validation.errors));
    }

    const started = sc(await call("start_asset_flow_run", { sessionId, mode }));
    const taskId = started.task?.id;
    let status, runId, run;
    for (let i = 0; i < pollLimit; i++) {
      const p = sc(await call("get_asset_flow_task", { taskId }));
      status = p.task?.status;
      if (i % 5 === 0 || status !== "working") log(`    poll ${i + 1}: ${status}`);
      if (status === "completed" || status === "failed") {
        run = p.run ?? {};
        runId = run.id || run.run_id || p.task?.run_id;
        break;
      }
      await sleep(pollMs);
    }
    if (status !== "completed") log(`    batch ${idx + 1} status=${status} err=${run?.error ?? "?"}`);

    try {
      const trace = sc(await call("get_flow_trace", { sessionId, runId }));
      const bad = (trace.nodes || []).filter((n) => n.node_id?.startsWith("g_") && n.status !== "COMPLETED");
      if (bad.length) log(`    failed nodes: ${bad.map((n) => `${n.node_id}(${n.status}${n.error ? `:${n.error}` : ""})`).join(", ")}`);
    } catch {
      /* trace is best-effort */
    }

    const outRes = await call("get_flow_outputs", { sessionId, runId });
    const outputs = sc(outRes).outputs ?? [];
    const blobs = (outRes.content ?? []).filter((b) => b.type === "image");
    const saved = [];
    for (let k = 0; k < blobs.length; k++) {
      const id = itemIdOfOutput(outputs[k]?.node_id);
      if (!id) continue;
      images.set(id, Buffer.from(blobs[k].data, "base64"));
      saved.push(id);
    }
    log(`    received ${saved.length}: ${saved.join(", ")}`);
    return { sessionId, runId, saved, cost: run?.total_cost_usd };
  }

  try {
    const who = sc(await call("whoami_brandbrain", {}));
    if (!who.authenticated) {
      throw new Error("not authenticated to brandbrain: run the MCP's login_brandbrain once");
    }
    log(`auth: ${who.user?.email}`);
    const batches = chunk(items, batchSize);
    for (let i = 0; i < batches.length; i++) {
      log(`batch ${i + 1}/${batches.length} (${batches[i].map((b) => b.id).join(", ")})`);
      try {
        results.push(await runBatch(batches[i], i));
      } catch (e) {
        log(`  batch ${i + 1} FAILED: ${e.message}`);
        results.push({ error: e.message });
      }
    }
  } finally {
    await client.close();
  }
  return { results, images };
}
