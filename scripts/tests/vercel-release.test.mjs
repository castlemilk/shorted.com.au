import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  CLI_VERSION,
  NODE_VERSION,
  assertSource,
  failureKind,
  boundedRead,
  deploymentRecord,
  assertDeployment,
  assertRuntime,
  jsonRead,
} from "../vercel-release.mjs";

const sha = "a".repeat(40);
const record = { id: "dpl_123", url: "https://shorted-example.vercel.app" };
const link = {
  projectName: "shorted-com-au",
  projectId: "prj_fixture",
  orgId: "team_fixture",
};
const deployment = {
  ...record,
  url: "shorted-example.vercel.app",
  name: link.projectName,
  projectId: link.projectId,
  ownerId: link.orgId,
  target: "production",
  readyState: "READY",
  meta: { shortedCommitSha: sha },
};
const workflowSource = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);
const require = createRequire(
  new URL("../../web/package.json", import.meta.url),
);
const workflow = require("js-yaml").load(workflowSource);
const job = workflow.jobs["deploy-vercel-prod"];

test("source must be the complete checked-out SHA", () => {
  assertSource(sha, sha);
  for (const value of [undefined, "main", sha.slice(0, 7), "b".repeat(40)])
    assert.throws(() => assertSource(sha, value));
});

for (const message of [
  "Challenge required",
  '{"error":{"code":"challenge_required"}}',
  "Sensitive Environment Variables require fresh authentication. ECONNRESET",
]) {
  test(`authentication challenge is terminal: ${message}`, async () => {
    let reads = 0;
    await assert.rejects(
      boundedRead(
        () => {
          reads++;
          return { ok: false, message };
        },
        { wait: () => assert.fail("must not retry") },
      ),
      /account owner.*supported authentication challenge/,
    );
    assert.equal(reads, 1);
  });
}

test("read retries are bounded to three attempts with a fixed backoff", async () => {
  let reads = 0;
  const waits = [];
  const value = await boundedRead(
    () =>
      ++reads < 3
        ? { ok: false, code: "ECONNRESET" }
        : { ok: true, value: "ready" },
    { wait: (ms) => waits.push(ms) },
  );
  assert.equal(value, "ready");
  assert.equal(reads, 3);
  assert.deepEqual(waits, [1000, 3000]);
});

test("exhausted reads stop without echoing provider output", async () => {
  let reads = 0;
  await assert.rejects(
    boundedRead(
      () => {
        reads++;
        return {
          ok: false,
          code: "ETIMEDOUT",
          message: "fixture-private-value",
        };
      },
      { wait: () => {} },
    ),
    (error) => !error.message.includes("fixture-private-value"),
  );
  assert.equal(reads, 3);
});

for (const status of [401, 403, 400, 404, 409])
  test(`HTTP ${status} is not retried`, async () => {
    let reads = 0;
    await assert.rejects(
      boundedRead(
        () => {
          reads++;
          return { ok: false, status };
        },
        { wait: () => assert.fail() },
      ),
    );
    assert.equal(reads, 1);
  });

test("only recognized transient read failures qualify", () => {
  for (const status of [429, 502, 503, 504])
    assert.equal(failureKind({ status }), "transient");
  assert.equal(
    failureKind({ status: 403, code: "ECONNRESET" }),
    "authorization",
  );
  assert.equal(failureKind({ message: "build failed" }), "failure");
});

test("JSON upload output records one deployment instead of scraping log URLs", () => {
  const payload = { ...record, target: "production", readyState: "READY" };
  assert.deepEqual(deploymentRecord(payload), record);
  assert.deepEqual(
    deploymentRecord({ status: "ok", deployment: payload }),
    record,
  );
  for (const change of [
    { target: "preview" },
    { readyState: "BUILDING" },
    { id: "other" },
    { url: "https://example.com" },
    { url: `${record.url}/other` },
    { url: "https://user@shorted-example.vercel.app" },
  ])
    assert.throws(() => deploymentRecord({ ...payload, ...change }));
  assert.throws(() =>
    deploymentRecord({ status: "error", deployment: payload }),
  );
});

test("READY deployment must match the exact upload receipt and source", () => {
  assertDeployment(deployment, record, link, sha);
});
for (const [name, change] of Object.entries({
  source: { meta: { shortedCommitSha: "b".repeat(40) } },
  missingSource: { meta: {} },
  id: { id: "dpl_other" },
  url: { url: "other.vercel.app" },
  name: { name: "other-project" },
  project: { projectId: "prj_other" },
  owner: { ownerId: "team_other" },
  target: { target: "preview" },
  state: { readyState: "BUILDING" },
  aliasError: { aliasError: { code: "failed" } },
  checks: { checksConclusion: "failed" },
  cancelledChecks: { checksConclusion: "canceled" },
  runningChecks: { checksState: "running" },
  registeredChecks: { checksState: "registered" },
  pendingAliasCheck: { checks: { "deployment-alias": { state: "pending" } } },
}))
  test(`promotion rejects mismatched ${name}`, () =>
    assert.throws(() =>
      assertDeployment({ ...deployment, ...change }, record, link, sha),
    ));

test("an old healthy runtime cannot satisfy the exact commit assertion", () => {
  assertRuntime({ gitCommitFull: sha }, sha);
  assert.throws(() => assertRuntime({ gitCommit: sha.slice(0, 7) }, sha));
  assert.throws(() =>
    assertRuntime(
      { gitCommitFull: `${sha.slice(0, 7)}${"b".repeat(33)}` },
      sha,
    ),
  );
});

test("metadata reads reject redirects, retry plain-text 503 and never print response bodies", async () => {
  let reads = 0;
  const fetcher = async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    return ++reads === 1
      ? new Response("temporary outage", { status: 503 })
      : Response.json({ ready: true });
  };
  assert.deepEqual(
    await jsonRead("https://example.invalid", {}, fetcher, { wait: () => {} }),
    { ready: true },
  );
  assert.equal(reads, 2);
});

test("production preflight precedes cloud lookup, dependency install and compilation", () => {
  const names = job.steps.map((step) => step.name);
  assert.ok(
    names.indexOf("Preflight production Vercel access") <
      names.indexOf("Authenticate to Google Cloud"),
  );
  assert.ok(
    names.indexOf("Preflight production Vercel access") <
      names.indexOf("Build and upload production deployment"),
  );
  assert.equal(
    job.steps.find(
      (step) => step.name === "Set up Node for production deployment",
    ).with["node-version"],
    NODE_VERSION,
  );
  const body = job.steps.find((step) => step.id === "vercel-deploy").run;
  assert.equal(job.steps.find((step) => step.id === "vercel-deploy").env.SKIP_VERSION_BUMP, "1");
  for (const pin of body.matchAll(/vercel@(\d+\.\d+\.\d+)/g))
    assert.equal(pin[1], CLI_VERSION);
  assert.match(body, /--meta "shortedCommitSha=\$\{GITHUB_SHA\}"/);
  assert.match(body, /deploy_args\+=\(--env "\$\{name\}"\)/);
  assert.doesNotMatch(
    body,
    /--token|deploy_args\+=\(--env "\$\{name\}=|tee \/tmp\/vercel/,
  );
});

test("promotion verifies the uploaded deployment, refuses stale main and requires live identity afterward", () => {
  const promote = job.steps.find(
    (step) => step.name === "Promote Vercel deployment to production",
  );
  assert.ok(
    promote.run.indexOf("verify-deployment") <
      promote.run.indexOf("vercel promote"),
  );
  assert.match(promote.run, /current_main_sha.*!=.*GITHUB_SHA/);
  assert.match(
    promote.env.DEPLOYMENT_ID,
    /vercel-deploy.outputs.deployment-id/,
  );
  assert.ok(
    job.steps.findIndex((step) => step.run?.includes("verify-production")) >
      job.steps.indexOf(promote),
  );
  for (const step of job.steps.filter((step) => step.run))
    assert.equal(
      spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" }).status,
      0,
      step.name,
    );
});
