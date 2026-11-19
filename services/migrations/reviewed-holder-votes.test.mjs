import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL("./000161_reviewed_holder_votes.up.sql", import.meta.url), "utf8");
const reviewed = JSON.parse(readFileSync(new URL("../../web/src/@/lib/ownership/reviewed-filing-votes.json", import.meta.url), "utf8"));

test("the tracker and the PostgreSQL seed quote the same two source PDFs and voting tables", () => {
  const values = sql.split("VALUES\n")[1].split("ON CONFLICT")[0];
  const rows = [...values.matchAll(/\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*([\d.]+),\s*([\d.]+),\s*(\d+),\s*(\d+),\s*(true|false)\)/g)];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(([, announcement, code, form, name, source, prev, current, previousVotes, votes, ceased]) => ({
    code, form, name, announcement, source, previousPct: Number(prev), pct: Number(current), previousVotes: Number(previousVotes), votes: Number(votes), ceased: ceased === "true",
  })), reviewed);
});

test("the normal migration session applies the review after the ownership tables exist", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url), "utf8");
  const line = "run_psql_session -f /migrations/000161_reviewed_holder_votes.up.sql";
  assert.equal(workflow.split(line).length - 1, 1);
  assert.ok(workflow.indexOf(line) > workflow.indexOf("/migrations/000137_add_ownership.up.sql"));
});
