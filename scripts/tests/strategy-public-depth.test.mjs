// The anonymous depth of the strategy picks is one number, written in five
// places: the Terraform value the API reads (strategy_public_signals_limit), the
// Overview's shortlist (SHORTLIST_MAX_ROWS), the Signals tab's public rows
// (SIGNALS_PUBLIC_ROWS), the get_strategy_picks description and llms-full.txt.
// A change to one that leaves the others publishing a ceiling that is no longer
// enforced is the defect this pins.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const terraform = read("../../terraform/environments/prod/main.tf");
const shortlist = read("../../web/src/@/lib/strategies/shortlist.ts");
const signals = read("../../web/src/@/lib/strategies/signals.ts");
const mcpTools = read("../../services/shorts/internal/mcp/tools_strategies.go");
const llmsFull = read("../../web/public/llms-full.txt");

function numberOf(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `${label} not found`);
  return Number(match[1]);
}

const depth = numberOf(
  terraform,
  /strategy_public_signals_limit\s*=\s*(\d+)/,
  "strategy_public_signals_limit in terraform/environments/prod/main.tf",
);

test("the public depth is set in production", () => {
  assert.equal(depth, 10);
});

test("the Overview shortlist and the Signals tab show the public depth", () => {
  assert.equal(
    numberOf(shortlist, /export const SHORTLIST_MAX_ROWS = (\d+);/, "SHORTLIST_MAX_ROWS"),
    depth,
  );
  assert.equal(
    numberOf(signals, /export const SIGNALS_PUBLIC_ROWS = (\d+);/, "SIGNALS_PUBLIC_ROWS"),
    depth,
  );
});

test("the MCP description names the public depth it serves", () => {
  assert.equal(
    numberOf(mcpTools, /Without sign-in, the top (\d+) only; connected with OAuth, up to 25\./, "MCP depth clause"),
    depth,
  );
});

test("llms-full.txt names the public depth and the signed-in route to full depth", () => {
  assert.equal(
    numberOf(llmsFull, /the top (\d+) of the default ranking for every caller/, "llms-full depth"),
    depth,
  );
  assert.match(llmsFull, /GetViewerStrategyPicks/);
});
