import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
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
  promotionDecision,
  runtimeUrl,
  verifyRuntime,
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

test("promotion verifies the uploaded deployment and does not refuse on main movement", () => {
  const promote = step("Promote Vercel deployment to production");
  assert.ok(
    promote.indexOf("verify-deployment") < promote.indexOf("vercel promote"),
  );
  // Main moving mid-release is normal; the decision step compares what production serves.
  assert.doesNotMatch(promote, /ls-remote|current_main_sha/);
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

// ---------------------------------------------------------------------------
// Release decision, runtime identity and the access probe, run as the real
// CLI entry point against stubbed HTTP. No network and no Vercel account.
// ---------------------------------------------------------------------------
const other = "b".repeat(40);
const scriptPath = fileURLToPath(new URL("../vercel-release.mjs", import.meta.url));

function checkout(t) {
  const dir = mkdtempSync(join(tmpdir(), "shorted-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".vercel\n");
  git("add", ".gitignore");
  git("-c", "user.email=r@example.invalid", "-c", "user.name=r", "commit", "-qm", "fixture");
  return [dir, git("rev-parse", "HEAD").stdout.trim()];
}

// Every fetch is answered from `routes` by URL substring; anything unrouted is a loud 599.
function routedFetch(dir, routes) {
  const file = join(dir, "routed-fetch.mjs");
  const log = join(dir, "routed-requests.ndjson");
  writeFileSync(file, `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(url) }) + "\\n");
    const hit = ${JSON.stringify(routes)}.find((r) => String(url).includes(r.match));
    if (!hit) return new Response("unrouted " + url, { status: 599 });
    return new Response(hit.body, { status: hit.status ?? 200, headers: { "content-type": "application/json" } });
  };`);
  return file;
}
const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });

function runCli(dir, operation, env, imports = []) {
  return spawnSync(
    process.execPath,
    [...imports.flatMap((f) => ["--import", f]), scriptPath, operation],
    { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } },
  );
}

// A fake pinned CLI on PATH: `body` runs as dist/vc.js.
function fakeCli(dir, body) {
  const pkg = join(dir, "fake-cli/node_modules/vercel");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  mkdirSync(join(dir, "fake-cli/bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "vercel", version: CLI_VERSION }));
  writeFileSync(join(pkg, "dist/vc.js"), body);
  symlinkSync(join(pkg, "dist/vc.js"), join(dir, "fake-cli/bin/vercel"));
  return join(dir, "fake-cli/bin");
}

// CI pins Node exactly; present this process as that patch so the probe is reached.
function pinNode(dir) {
  const pin = join(dir, "pin-node.mjs");
  writeFileSync(pin, `Object.defineProperty(process, "versions", { value: { ...process.versions, node: ${JSON.stringify(NODE_VERSION)} } });`);
  return pin;
}

const goodLink = { projectName: "shorted-com-au", projectId: "prj_fixture", orgId: "team_fixture" };

test("post-promotion runtime check reads the promoted deployment, never the challenged apex", (t) => {
  const [dir, sha] = checkout(t);
  const challenge = { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge" }, body: "<title>Just a moment...</title>" };
  const fetchFile = routedFetch(dir, [{ match: "/api/version", ...challenge }]);
  const result = runCli(dir, "verify-production", {
    GITHUB_SHA: sha, DEPLOYMENT_URL: "https://shorted-fixture.vercel.app",
  }, [fetchFile]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /authorization/);
  const [request] = readFileSync(join(dir, "routed-requests.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const requested = new URL(request.url);
  assert.equal(requested.hostname, "shorted-fixture.vercel.app", "the runtime check must not target the Cloudflare apex");
  assert.equal(requested.pathname, "/api/version");
  assert.match(runtimeUrl("https://shorted-fixture.vercel.app", sha).href, /^https:\/\/shorted-fixture\.vercel\.app\/api\/version\?/);
});

test("verify-production refuses a runtime that serves an older commit, without waiting", (t) => {
  const [dir, sha] = checkout(t);
  const fetchFile = routedFetch(dir, [{ match: "/api/version", ...json({ gitCommitFull: other }) }]);
  const result = runCli(dir, "verify-production", {
    GITHUB_SHA: sha, DEPLOYMENT_URL: "https://shorted-fixture.vercel.app", RUNTIME_VERIFY_WINDOW_MS: "0",
  }, [fetchFile]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Release SHA must exactly match/);
});

test("verify-deployment refuses a READY deployment built from another commit", (t) => {
  const [dir, sha] = checkout(t);
  mkdirSync(join(dir, ".vercel"));
  writeFileSync(join(dir, ".vercel/project.json"), JSON.stringify(goodLink));
  const deploymentBody = {
    id: "dpl_fixture", url: "shorted-fixture.vercel.app", name: goodLink.projectName,
    projectId: goodLink.projectId, ownerId: goodLink.orgId, target: "production", readyState: "READY",
    meta: { shortedCommitSha: other },
  };
  const fetchFile = routedFetch(dir, [{ match: "/v13/deployments/", ...json(deploymentBody) }]);
  const result = runCli(dir, "verify-deployment", {
    GITHUB_SHA: sha, DEPLOYMENT_ID: "dpl_fixture", DEPLOYMENT_URL: "https://shorted-fixture.vercel.app", VERCEL_TOKEN: "fixture",
  }, [fetchFile]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Release SHA must exactly match/);
});

test("a failed non-challenge pull fails preflight even when the CLI left a valid link", (t) => {
  const [dir, sha] = checkout(t);
  const bin = fakeCli(dir, `require("node:fs").mkdirSync(".vercel", { recursive: true });
require("node:fs").writeFileSync(".vercel/project.json", ${JSON.stringify(JSON.stringify(goodLink))});
process.stderr.write("Error: network down\\n"); process.exit(1);`);
  const result = spawnSync(process.execPath, ["--import", pinNode(dir), scriptPath, "preflight"], {
    cwd: dir, encoding: "utf8",
    env: { PATH: bin + delimiter + process.env.PATH, HOME: process.env.HOME, GITHUB_SHA: sha, VERCEL_TOKEN: "fixture" },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Vercel read failed \(failure\)/);
});

test("preflight reads its link from a throwaway directory and leaves the source tree untouched", (t) => {
  const [dir, sha] = checkout(t);
  const bin = fakeCli(dir, `require("node:fs").mkdirSync(".vercel", { recursive: true });
require("node:fs").writeFileSync(".vercel/project.json", ${JSON.stringify(JSON.stringify(goodLink))});
require("node:fs").writeFileSync(".vercel/.env.production.local", "SECRET=1");
process.exit(0);`);
  const result = spawnSync(process.execPath, ["--import", pinNode(dir), scriptPath, "preflight"], {
    cwd: dir, encoding: "utf8",
    env: { PATH: bin + delimiter + process.env.PATH, HOME: process.env.HOME, GITHUB_SHA: sha, VERCEL_TOKEN: "fixture" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(dir, ".vercel")), false, "no project link or env file may exist before npm ci");
});

test("preflight stops on the CLI's challenge output and never retries it", (t) => {
  const [dir, sha] = checkout(t);
  const bin = fakeCli(dir, `require("node:fs").appendFileSync(${JSON.stringify(join(dir, "cli-calls"))}, "x");
process.stderr.write("Error: Challenge required (403)\\n"); process.exit(1);`);
  const result = spawnSync(process.execPath, ["--import", pinNode(dir), scriptPath, "preflight"], {
    cwd: dir, encoding: "utf8",
    env: { PATH: bin + delimiter + process.env.PATH, HOME: process.env.HOME, GITHUB_SHA: sha, VERCEL_TOKEN: "fixture" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /authentication challenge/);
  assert.equal(readFileSync(join(dir, "cli-calls"), "utf8"), "x", "a challenge is never retried");
});

test("promotion decision skips only when production descends from this release", () => {
  assert.equal(promotionDecision(other, sha, { status: "ahead" }), "skip");
  assert.equal(promotionDecision(other, sha, { status: "behind" }), "promote");
  assert.equal(promotionDecision(other, sha, { status: "diverged" }), "promote");
  assert.equal(promotionDecision(sha, sha, undefined), "promote");
  assert.throws(() => promotionDecision(undefined, sha, { status: "ahead" }), /full commit/);
  assert.throws(() => promotionDecision("not-a-sha", sha, { status: "ahead" }), /full commit/);
});

test("check-promotion skips a release that production already descends from, successfully", (t) => {
  const [dir, sha] = checkout(t);
  const output = join(dir, "github-output");
  const fetchFile = routedFetch(dir, [
    { match: "/v6/deployments", ...json({ deployments: [{ target: "production", readyState: "READY", url: "shorted-prod.vercel.app" }] }) },
    { match: "/api/version", ...json({ gitCommitFull: other }) },
    { match: "api.github.com/repos/castlemilk/shorted.com.au/compare/", ...json({ status: "ahead" }) },
  ]);
  const result = runCli(dir, "check-promotion", {
    GITHUB_SHA: sha, GITHUB_REPOSITORY: "castlemilk/shorted.com.au", VERCEL_TOKEN: "fixture", GITHUB_OUTPUT: output,
  }, [fetchFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "promote=false\n");
  assert.match(result.stdout, /not a failure/);
});

test("check-promotion promotes when production serves an older or diverged commit", (t) => {
  const [dir, sha] = checkout(t);
  const output = join(dir, "github-output");
  const fetchFile = routedFetch(dir, [
    { match: "/v6/deployments", ...json({ deployments: [{ target: "production", readyState: "READY", url: "shorted-prod.vercel.app" }] }) },
    { match: "/api/version", ...json({ gitCommitFull: other }) },
    { match: "/compare/", ...json({ status: "diverged" }) },
  ]);
  const result = runCli(dir, "check-promotion", {
    GITHUB_SHA: sha, GITHUB_REPOSITORY: "castlemilk/shorted.com.au", VERCEL_TOKEN: "fixture", GITHUB_OUTPUT: output,
  }, [fetchFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "promote=true\n");
});

test("check-promotion fails closed when production cannot be read", (t) => {
  const [dir, sha] = checkout(t);
  const output = join(dir, "github-output");
  const fetchFile = routedFetch(dir, [
    { match: "/v6/deployments", ...json({ deployments: [] }) },
  ]);
  const result = runCli(dir, "check-promotion", {
    GITHUB_SHA: sha, GITHUB_REPOSITORY: "castlemilk/shorted.com.au", VERCEL_TOKEN: "fixture", GITHUB_OUTPUT: output,
  }, [fetchFile]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No READY production deployment/);
  assert.equal(existsSync(output), false, "no promote decision may be written");
});

test("runtime verification retries a commit mismatch within its window, not an authorization failure", async () => {
  const replies = [json({ gitCommitFull: other }), json({ gitCommitFull: sha })];
  let requests = 0;
  let clock = 0;
  const fetcher = async () => {
    const reply = replies[Math.min(requests++, replies.length - 1)];
    return new Response(reply.body, { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  };
  await verifyRuntime("https://shorted-fixture.vercel.app", sha, {
    fetcher, wait: async (ms) => { clock += ms; }, now: () => clock, windowMs: 90_000,
  });
  assert.equal(requests, 2, "one stale read, then the exact commit");

  let forbidden = 0;
  await assert.rejects(
    verifyRuntime("https://shorted-fixture.vercel.app", sha, {
      fetcher: async () => { forbidden++; return new Response("{}", { status: 403, headers: { "content-type": "application/json" } }); },
      wait: async () => {}, now: () => 0, windowMs: 90_000,
    }),
    /authorization/,
  );
  assert.equal(forbidden, 1, "an authorization failure is never retried");

  let stale = 0;
  clock = 0;
  await assert.rejects(
    verifyRuntime("https://shorted-fixture.vercel.app", sha, {
      fetcher: async () => { stale++; return new Response(JSON.stringify({ gitCommitFull: other }), { status: 200, headers: { "content-type": "application/json" } }); },
      wait: async (ms) => { clock += ms; }, now: () => clock, windowMs: 90_000,
    }),
    /Release SHA must exactly match/,
  );
  assert.ok(clock <= 90_000, `waits stay inside the window, waited ${clock}ms`);
  assert.ok(stale >= 3, `a stale commit is retried through propagation, got ${stale} reads`);
});

test("the release decision runs before cloud lookup, build and promotion, and gates each of them", () => {
  const steps = parse(workflowSource).jobs["deploy-vercel-prod"].steps;
  const names = steps.map((s) => s.name);
  const at = (name) => names.indexOf(name);
  const decision = at("Decide whether production needs this release");
  assert.ok(decision > at("Preflight production Vercel access"));
  for (const gated of [
    "Authenticate to Google Cloud",
    "Resolve Service URLs",
    "Build and upload production deployment",
    "Promote Vercel deployment to production",
  ]) {
    assert.ok(at(gated) > decision, `${gated} must follow the decision`);
    assert.match(steps[at(gated)].if, /steps\.release-check\.outputs\.promote == 'true'/, gated);
    assert.match(steps[at(gated)].if, /success\(\)/, `${gated} must not run after a failure`);
  }
  const promote = at("Promote Vercel deployment to production");
  const verify = at("Verify exact production web commit");
  assert.ok(verify > promote, "runtime verification follows promotion");
  assert.match(steps[verify].if, /steps\.vercel-promote\.outcome == 'success'/);
  assert.ok(!steps[promote].run.includes("ls-remote"), "no main-moved refusal");
  assert.equal(steps[verify].env.DEPLOYMENT_URL, "${{ steps.vercel-deploy.outputs.deployment-url }}");
});

test("post-promotion ISR revalidation and priming run whenever promotion succeeded", () => {
  const steps = parse(workflowSource).jobs["deploy-vercel-prod"].steps;
  const verify = steps.find((s) => s.name === "Verify exact production web commit");
  assert.notEqual(verify["continue-on-error"], true, "a failed runtime check must still fail the job");
  for (const name of ["Revalidate ISR pages post-promote", "Prime static pages after promotion"]) {
    const found = steps.find((s) => s.name === name);
    assert.match(found.if, /!cancelled\(\)/, name);
    assert.match(found.if, /steps\.vercel-promote\.outcome == 'success'/, name);
  }
});

test("the build pulls the project after npm ci and before vercel build", () => {
  const build = step("Build and upload production deployment");
  const install = build.indexOf("npm --prefix web ci");
  const pull = build.indexOf("vercel pull --yes --environment production");
  // The bare words "vercel build" also appear in a comment above npm ci.
  const compile = build.indexOf("vercel@54.10.2 vercel build");
  assert.ok(install > -1 && install < pull && pull < compile);
});

test("the portal provenance job has room for the pinned CLI contract test", () => {
  const hygiene = parse(readFileSync(new URL("../../.github/workflows/repo-hygiene.yml", import.meta.url), "utf8"));
  assert.ok(hygiene.jobs["portal-content-provenance"]["timeout-minutes"] >= 12);
});
