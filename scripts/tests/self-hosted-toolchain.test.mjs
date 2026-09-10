// The self-hosted runner image is NOT a contract.
//
// PR #600 moved every job onto the Cuttlefish Linux runners — three
// hand-created actions/runner containers on one Mac, provisioned by no script
// in this repo. #609 found the first consequence: GitHub's images ship psql and
// gh, a bare actions/runner container does not, and housing-freshness had been
// exiting 127 in 9ms without ever running a query.
//
// On 2026-09-10 all three runners vanished (their containers pruned, their
// image gone) and had to be rebuilt from scratch. The rebuilt image failed
// release-preview-smoke's deploy job with `npm: command not found`, exit 127 —
// the same defect in a different tool, found the same way: in production, by a
// red PR.
//
// So: any job that invokes node, npm or npx on the RUNNER (not inside a
// `container:`, which brings its own toolchain) must ask for Node explicitly.
// Then whoever rebuilds that image next cannot break CI by leaving something
// out of it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflowsDir = new URL("../../.github/workflows/", import.meta.url);

const NODE_INVOCATION = /(^|[\s;&|(])(node|npm|npx)([\s;&|)]|$)/m;

function selfHostedJobs() {
  const jobs = [];
  for (const file of readdirSync(workflowsDir)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    let doc;
    try {
      doc = parse(readFileSync(new URL(file, workflowsDir), "utf8"));
    } catch (err) {
      assert.fail(`${file} is not parseable YAML: ${err.message}`);
    }
    for (const [id, job] of Object.entries(doc?.jobs ?? {})) {
      if (!job || typeof job !== "object") continue;
      const runsOn = Array.isArray(job["runs-on"]) ? job["runs-on"] : [job["runs-on"]];
      if (!runsOn.includes("self-hosted")) continue;
      jobs.push({ file, id, job });
    }
  }
  return jobs;
}

test("self-hosted jobs that run node/npm provide their own Node", () => {
  const offenders = [];
  for (const { file, id, job } of selfHostedJobs()) {
    // A `container:` job runs inside its own image, which supplies the
    // toolchain — that is an explicit choice, not a dependency on the host.
    if (job.container) continue;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const invokesNode = steps.some((s) => typeof s?.run === "string" && NODE_INVOCATION.test(s.run));
    if (!invokesNode) continue;
    const setsUpNode = steps.some((s) => String(s?.uses ?? "").startsWith("actions/setup-node@"));
    if (!setsUpNode) offenders.push(`${file}:${id}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these self-hosted jobs call node/npm/npx but never run actions/setup-node, so they ` +
      `depend on whatever happens to be baked into the runner image: ${offenders.join(", ")}`,
  );
});

// The inverse guard: this test is only meaningful while some job actually
// matches it. If the detector silently stops finding anything — a renamed key,
// a YAML shape change — it would pass forever while protecting nothing.
test("the detector still sees self-hosted jobs at all", () => {
  assert.ok(selfHostedJobs().length > 0, "no self-hosted jobs found — has runs-on moved or been renamed?");
});
