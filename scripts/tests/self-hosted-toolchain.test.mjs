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
//
// This parses the workflows by INDENTATION rather than with a YAML library on
// purpose: the repo-hygiene job that runs these tests does a checkout and
// `node --test`, with no `npm ci`, so a test that imports a dependency fails
// there while passing locally. (Which is, fittingly, the same class of bug.)
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const workflowsDir = new URL("../../.github/workflows/", import.meta.url);

const NODE_INVOCATION = /(^|[\s;&|(`$])(node|npm|npx)([\s;&|)]|$)/;

// splitJobs returns the top-level entries of the `jobs:` mapping as
// { id, body } — body being every line indented under `  <id>:`.
function splitJobs(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return [];
  const jobs = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    // A new top-level key ends the jobs mapping entirely.
    if (/^\S/.test(line)) break;
    const header = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (header) {
      current = { id: header[1], lines: [] };
      jobs.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return jobs.map((j) => ({ id: j.id, body: j.lines.join("\n") }));
}

function selfHostedJobs() {
  const jobs = [];
  for (const file of readdirSync(workflowsDir)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const source = readFileSync(new URL(file, workflowsDir), "utf8");
    for (const job of splitJobs(source)) {
      if (!/^\s*runs-on:.*self-hosted/m.test(job.body)) continue;
      jobs.push({ file, ...job });
    }
  }
  return jobs;
}

test("self-hosted jobs that run node/npm provide their own Node", () => {
  const offenders = [];
  for (const { file, id, body } of selfHostedJobs()) {
    // A `container:` job runs inside its own image, which supplies the
    // toolchain — that is an explicit choice, not a dependency on the host.
    if (/^ {4}container:\s*$/m.test(body)) continue;

    const invokesNode = body.split("\n").some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return false;
      // Skip the metadata lines, where these words are prose, not commands.
      if (/^(name|uses|if|id|working-directory):/.test(trimmed)) return false;
      return NODE_INVOCATION.test(trimmed.replace(/^run:\s*/, ""));
    });
    if (!invokesNode) continue;

    if (!/uses:\s*actions\/setup-node@/.test(body)) offenders.push(`${file}:${id}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these self-hosted jobs call node/npm/npx but never run actions/setup-node, so they ` +
      `depend on whatever happens to be baked into the runner image: ${offenders.join(", ")}`,
  );
});

// The inverse guard: this test is only meaningful while the detector still
// finds jobs. A renamed key or a reformatted workflow would otherwise leave it
// passing forever while protecting nothing.
test("the detector still sees self-hosted jobs, with steps", () => {
  const jobs = selfHostedJobs();
  assert.ok(jobs.length > 5, `only ${jobs.length} self-hosted jobs found — has runs-on moved or been renamed?`);
  assert.ok(
    jobs.some(({ body }) => /^ {4}steps:\s*$/m.test(body)),
    "no job body contained a steps: block — the indentation split has drifted from the file format",
  );
});
