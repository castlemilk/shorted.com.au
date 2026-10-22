import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const job = workflowSource.slice(
  workflowSource.indexOf("  deploy-vercel-prod:"),
);
function step(name) {
  const start = job.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, name);
  const end = job.indexOf("\n      - name:", start + 1);
  return job.slice(start, end === -1 ? undefined : end);
}

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
      /interactive challenge.*not the explicit CI token.*account owner.*separate approval/,
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
  const names = [...job.matchAll(/^      - name: (.+)$/gm)].map(
    (match) => match[1],
  );
  assert.ok(
    names.indexOf("Preflight production Vercel access") <
      names.indexOf("Authenticate to Google Cloud"),
  );
  assert.ok(
    names.indexOf("Preflight production Vercel access") <
      names.indexOf("Build and upload production deployment"),
  );
  assert.match(
    step("Set up Node for production deployment"),
    new RegExp(`node-version: "${NODE_VERSION.replaceAll(".", "\\.")}"`),
  );
  const body = step("Build and upload production deployment");
  assert.match(body, /SKIP_VERSION_BUMP: "1"/);
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
  const promote = step("Promote Vercel deployment to production");
  assert.ok(
    promote.indexOf("verify-deployment") < promote.indexOf("vercel promote"),
  );
  assert.match(promote, /current_main_sha.*!=.*GITHUB_SHA/);
  assert.match(promote, /DEPLOYMENT_ID:.*vercel-deploy.outputs.deployment-id/);
  assert.ok(job.indexOf("verify-production") > job.indexOf(promote));
  const lines = job.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "        run: |") continue;
    let body = "";
    while (
      ++i < lines.length &&
      (!lines[i].trim() || lines[i].startsWith("          "))
    )
      body += lines[i].slice(10) + "\n";
    assert.equal(
      spawnSync("bash", ["-n"], { input: body, encoding: "utf8" }).status,
      0,
    );
    i--;
  }
});

test("the actual prebuild hook leaves tracked package bytes untouched in release CI", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shorted-version-hook-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = '{"name":"fixture","version":"1.2.3"}\n';
  writeFileSync(join(directory, "package.json"), original);
  const script = fileURLToPath(
    new URL("../../web/scripts/bump-version.sh", import.meta.url),
  );
  const result = spawnSync("/bin/sh", [script], {
    cwd: directory,
    env: { SKIP_VERSION_BUMP: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(directory, "package.json"), "utf8"), original);
});
