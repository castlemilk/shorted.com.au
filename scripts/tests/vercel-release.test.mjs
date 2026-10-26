import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
  runtimeWindowMs,
  verifyRuntime,
  waitForAlias,
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
// Release decision, alias verification and runtime identity. Each check runs
// as the real CLI entry point against stubbed HTTP: no network, no account.
// ---------------------------------------------------------------------------
const other = "b".repeat(40);
const scriptPath = fileURLToPath(new URL("../vercel-release.mjs", import.meta.url));
const goodLink = { projectName: "shorted-com-au", projectId: "prj_fixture", orgId: "team_fixture" };
const liveDeployment = {
  id: "dpl_live", url: "shorted-prod.vercel.app", projectId: goodLink.projectId,
  target: "production", readyState: "READY",
};
const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });
const aliasRoute = (deploymentId = "dpl_live") => ({ match: "/v4/aliases/shorted.com.au", ...json({ deploymentId }) });
const deploymentRoute = (overrides = {}) => ({ match: "/v13/deployments/dpl_live", ...json({ ...liveDeployment, ...overrides }) });
const runtimeRoute = (commit, host = "shorted-prod.vercel.app") => ({ match: `${host}/api/version`, ...json(commit === undefined ? {} : { gitCommitFull: commit }) });
const compareRoute = (status) => ({ match: "/compare/", ...json({ status }) });

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

// The first route whose `match` is a substring of the URL answers. Each request
// is logged with its URL and headers so tests can assert exact paths and auth.
function routedFetch(dir, routes) {
  const file = join(dir, "routed-fetch.mjs");
  const log = join(dir, "routed-requests.ndjson");
  writeFileSync(file, `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, init = {}) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(url), headers: init.headers ?? {} }) + "\\n");
  const hit = ${JSON.stringify(routes)}.find((r) => String(url).includes(r.match));
  if (!hit) return new Response("unrouted " + url, { status: 599 });
  return new Response(hit.body, { status: hit.status ?? 200, headers: { "content-type": hit.type ?? "application/json" } });
};`);
  return file;
}
function requests(dir) {
  const file = join(dir, "routed-requests.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

// The runner temp directory holds the validated project link, as the preflight leaves it.
function runnerEnv(dir, extra = {}) {
  const runnerTemp = join(dir, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(join(runnerTemp, "shorted-vercel-link.json"), JSON.stringify(goodLink));
  return { RUNNER_TEMP: runnerTemp, VERCEL_TOKEN: "fixture", ...extra };
}

function runCli(dir, operation, env, imports = []) {
  const args = Array.isArray(operation) ? operation : [operation];
  return spawnSync(
    process.execPath,
    [...imports.flatMap((f) => ["--import", f]), scriptPath, ...args],
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

function preflightWith(dir, sha, cliBody, extraEnv = {}) {
  const bin = fakeCli(dir, cliBody);
  mkdirSync(join(dir, "runner-temp"), { recursive: true });
  return spawnSync(process.execPath, ["--import", pinNode(dir), scriptPath, "preflight"], {
    cwd: dir, encoding: "utf8",
    env: { PATH: bin + delimiter + process.env.PATH, HOME: process.env.HOME, GITHUB_SHA: sha, VERCEL_TOKEN: "fixture", RUNNER_TEMP: join(dir, "runner-temp"), ...extraEnv },
  });
}

const checkEnv = (sha, extra = {}) => ({ GITHUB_SHA: sha, GITHUB_REPOSITORY: "castlemilk/shorted.com.au", ...extra });

test("post-promotion check reads the promoted deployment, never the challenged apex", (t) => {
  const [dir, sha] = checkout(t);
  const challenge = { match: "shorted-fixture.vercel.app/api/version", status: 403, type: "text/html", body: "<title>Just a moment...</title>" };
  const fetchFile = routedFetch(dir, [aliasRoute("dpl_fixture"), challenge]);
  const result = runCli(dir, "verify-production", runnerEnv(dir, {
    GITHUB_SHA: sha, DEPLOYMENT_ID: "dpl_fixture", DEPLOYMENT_URL: "https://shorted-fixture.vercel.app",
  }), [fetchFile]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /authorization/);
  const sent = requests(dir).map((r) => new URL(r.url));
  assert.ok(sent.every((u) => u.hostname !== productionHostForTest), "nothing is requested from the apex");
  assert.equal(sent.filter((u) => u.pathname === "/api/version").length, 1, "a 403 challenge is terminal after one attempt");
  assert.ok(sent.some((u) => u.pathname === "/v4/aliases/shorted.com.au" && u.searchParams.get("teamId") === "team_fixture"));
});
const productionHostForTest = "shorted.com.au";

test("verify-production refuses a deployment that serves an older commit, without waiting", (t) => {
  const [dir, sha] = checkout(t);
  const fetchFile = routedFetch(dir, [aliasRoute("dpl_fixture"), runtimeRoute(other, "shorted-fixture.vercel.app")]);
  const result = runCli(dir, "verify-production", runnerEnv(dir, {
    GITHUB_SHA: sha, DEPLOYMENT_ID: "dpl_fixture", DEPLOYMENT_URL: "https://shorted-fixture.vercel.app", RUNTIME_VERIFY_WINDOW_MS: "0",
  }), [fetchFile]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Release SHA must exactly match/);
});

test("verify-production fails when the alias never moves to this upload", (t) => {
  const [dir, sha] = checkout(t);
  const fetchFile = routedFetch(dir, [aliasRoute("dpl_previous"), runtimeRoute(sha, "shorted-fixture.vercel.app")]);
  const result = runCli(dir, "verify-production", runnerEnv(dir, {
    GITHUB_SHA: sha, DEPLOYMENT_ID: "dpl_fixture", DEPLOYMENT_URL: "https://shorted-fixture.vercel.app", RUNTIME_VERIFY_WINDOW_MS: "0",
  }), [fetchFile]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /alias did not move/);
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
  const fetchFile = routedFetch(dir, [{ match: "/v13/deployments/dpl_fixture", ...json(deploymentBody) }]);
  const result = runCli(dir, "verify-deployment", runnerEnv(dir, {
    GITHUB_SHA: sha, DEPLOYMENT_ID: "dpl_fixture", DEPLOYMENT_URL: "https://shorted-fixture.vercel.app",
  }), [fetchFile]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Release SHA must exactly match/);
  assert.ok(requests(dir)[0].url.startsWith("https://api.vercel.com/v13/deployments/dpl_fixture?teamId=team_fixture"));
});

test("a failed non-challenge pull fails preflight even when the CLI left a valid link", (t) => {
  const [dir, sha] = checkout(t);
  const result = preflightWith(dir, sha, `require("node:fs").mkdirSync(".vercel", { recursive: true });
require("node:fs").writeFileSync(".vercel/project.json", ${JSON.stringify(JSON.stringify(goodLink))});
process.stderr.write("Error: network down\\n"); process.exit(1);`);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Vercel read failed \(failure\)/);
});

test("preflight keeps only the validated link in RUNNER_TEMP and leaves the source tree untouched", (t) => {
  const [dir, sha] = checkout(t);
  mkdirSync(join(dir, "runner-temp"));
  const result = preflightWith(dir, sha, `require("node:fs").mkdirSync(".vercel", { recursive: true });
require("node:fs").writeFileSync(".vercel/project.json", ${JSON.stringify(JSON.stringify(goodLink))});
require("node:fs").writeFileSync(".vercel/.env.production.local", "SECRET=1");
process.exit(0);`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(dir, ".vercel")), false, "no project link or env file may exist before npm ci");
  const runnerTemp = join(dir, "runner-temp");
  assert.deepEqual(readdirSync(runnerTemp), ["shorted-vercel-link.json"], "the probe directory is removed");
  assert.deepEqual(JSON.parse(readFileSync(join(runnerTemp, "shorted-vercel-link.json"), "utf8")), goodLink);
});

test("the release script takes its probe directory from RUNNER_TEMP, never os.tmpdir", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(source, /tmpdir\(\)/);
  assert.match(source, /process\.env\.RUNNER_TEMP/);
});

test("preflight stops on the CLI's challenge output and never retries it", (t) => {
  const [dir, sha] = checkout(t);
  const result = preflightWith(dir, sha, `require("node:fs").appendFileSync(${JSON.stringify(join(dir, "cli-calls"))}, "x");
process.stderr.write("Error: Challenge required (403)\\n"); process.exit(1);`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /authentication challenge/);
  assert.equal(readFileSync(join(dir, "cli-calls"), "utf8"), "x", "a challenge is never retried");
});

test("promotion decision skips only when production descends from this release", () => {
  assert.equal(promotionDecision(other, sha, { status: "ahead" }), "skip");
  assert.equal(promotionDecision(other, sha, { status: "behind" }), "promote");
  assert.equal(promotionDecision(other, sha, { status: "diverged" }), "promote");
  assert.equal(promotionDecision(sha, sha, undefined), "promote");
  assert.throws(() => promotionDecision(other, sha, undefined), /comparison is required/);
});

test("a production that reports no full commit is promoted, not refused", () => {
  for (const live of [undefined, "", "local", "4ef3cd1b", "4ef3cd1b-dirty", "A".repeat(40)])
    assert.equal(promotionDecision(live, sha, undefined), "promote", String(live));
});

test("check-promotion skips a release that production descends from, successfully", (t) => {
  const [dir, sha] = checkout(t);
  const output = join(dir, "github-output");
  const fetchFile = routedFetch(dir, [aliasRoute(), deploymentRoute(), runtimeRoute(other), compareRoute("ahead")]);
  const result = runCli(dir, "check-promotion", checkEnv(sha, runnerEnv(dir, { GITHUB_OUTPUT: output })), [fetchFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "promote=false\n");
  assert.match(result.stdout, /not a failure/);
});

test("check-promotion promotes when production serves an older or diverged commit", (t) => {
  const [dir, sha] = checkout(t);
  const output = join(dir, "github-output");
  const fetchFile = routedFetch(dir, [aliasRoute(), deploymentRoute(), runtimeRoute(other), compareRoute("diverged")]);
  const result = runCli(dir, "check-promotion", checkEnv(sha, runnerEnv(dir, { GITHUB_OUTPUT: output })), [fetchFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "promote=true\n");
});

test("check-promotion compares release...live, with the GitHub token, and nothing else", (t) => {
  const [dir, sha] = checkout(t);
  const fetchFile = routedFetch(dir, [aliasRoute(), deploymentRoute(), runtimeRoute(other), compareRoute("behind")]);
  const result = runCli(dir, "check-promotion", checkEnv(sha, runnerEnv(dir, {
    GITHUB_OUTPUT: join(dir, "github-output"), GH_TOKEN: "fixture-gh",
  })), [fetchFile]);
  assert.equal(result.status, 0, result.stderr);
  const compare = requests(dir).find((r) => r.url.includes("api.github.com"));
  assert.equal(new URL(compare.url).pathname, `/repos/castlemilk/shorted.com.au/compare/${sha}...${other}`, "base is this release, head is live");
  assert.equal(compare.headers.Authorization, "Bearer fixture-gh", "the compare call carries the GitHub token");
});

test("check-promotion without GH_TOKEN makes an unauthenticated compare call", (t) => {
  const [dir, sha] = checkout(t);
  const fetchFile = routedFetch(dir, [aliasRoute(), deploymentRoute(), runtimeRoute(other), compareRoute("behind")]);
  const result = runCli(dir, "check-promotion", checkEnv(sha, runnerEnv(dir, { GITHUB_OUTPUT: join(dir, "github-output") })), [fetchFile]);
  assert.equal(result.status, 0, result.stderr);
  const compare = requests(dir).find((r) => r.url.includes("api.github.com"));
  assert.equal(compare.headers.Authorization, undefined);
});

test("check-promotion promotes, with a warning, when production reports no full commit", (t) => {
  const [dir, sha] = checkout(t);
  const output = join(dir, "github-output");
  const fetchFile = routedFetch(dir, [aliasRoute(), deploymentRoute(), runtimeRoute("local")]);
  const result = runCli(dir, "check-promotion", checkEnv(sha, runnerEnv(dir, { GITHUB_OUTPUT: output })), [fetchFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "promote=true\n");
  assert.match(result.stdout, /::warning::/);
  assert.ok(!requests(dir).some((r) => r.url.includes("api.github.com")), "no comparison without a full commit");
});

test("check-promotion fails closed when production cannot be read, and writes no decision", (t) => {
  const [dir, sha] = checkout(t);
  const output = join(dir, "github-output");
  const fetchFile = routedFetch(dir, [{ match: "/v4/aliases/shorted.com.au", status: 500, body: "{}" }]);
  const result = runCli(dir, "check-promotion", checkEnv(sha, runnerEnv(dir, { GITHUB_OUTPUT: output })), [fetchFile]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(output), false, "no promote decision may be written");
});

test("check-promotion fails closed when the alias names a deployment that is not READY production", (t) => {
  const [dir, sha] = checkout(t);
  const output = join(dir, "github-output");
  const fetchFile = routedFetch(dir, [aliasRoute(), deploymentRoute({ readyState: "BUILDING" }), runtimeRoute(other), compareRoute("ahead")]);
  const result = runCli(dir, "check-promotion", checkEnv(sha, runnerEnv(dir, { GITHUB_OUTPUT: output })), [fetchFile]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /READY production deployment of this project/);
  assert.equal(existsSync(output), false);
});

test("check-promotion fails closed when the alias names another project's deployment", (t) => {
  const [dir, sha] = checkout(t);
  const fetchFile = routedFetch(dir, [aliasRoute(), deploymentRoute({ projectId: "prj_other" }), runtimeRoute(other), compareRoute("ahead")]);
  const result = runCli(dir, "check-promotion", checkEnv(sha, runnerEnv(dir)), [fetchFile]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /READY production deployment of this project/);
});

test("check-promotion --gate exits 2 for a skip and 0 for a promotion, without writing a decision", (t) => {
  const [dir, sha] = checkout(t);
  const output = join(dir, "github-output");
  const skip = routedFetch(dir, [aliasRoute(), deploymentRoute(), runtimeRoute(other), compareRoute("ahead")]);
  const skipped = runCli(dir, ["check-promotion", "--gate"], checkEnv(sha, runnerEnv(dir, { GITHUB_OUTPUT: output })), [skip]);
  assert.equal(skipped.status, 2, skipped.stderr);
  const promote = routedFetch(dir, [aliasRoute(), deploymentRoute(), runtimeRoute(other), compareRoute("behind")]);
  const promoted = runCli(dir, ["check-promotion", "--gate"], checkEnv(sha, runnerEnv(dir, { GITHUB_OUTPUT: output })), [promote]);
  assert.equal(promoted.status, 0, promoted.stderr);
  assert.equal(existsSync(output), false, "the gate never writes a decision output");
});

test("the runtime window accepts only a non-negative integer and defaults otherwise", () => {
  assert.equal(runtimeWindowMs(undefined), 90_000);
  assert.equal(runtimeWindowMs(""), 90_000);
  assert.equal(runtimeWindowMs("abc"), 90_000);
  assert.equal(runtimeWindowMs("-5"), 90_000);
  assert.equal(runtimeWindowMs("1.5e3"), 90_000);
  assert.equal(runtimeWindowMs("0"), 0);
  assert.equal(runtimeWindowMs("120000"), 120_000);
});

test("alias polling waits for the alias to move, then returns, inside its window", async () => {
  const ids = ["dpl_previous", "dpl_previous", "dpl_fixture"];
  let reads = 0;
  let clock = 0;
  await waitForAlias(goodLink, "fixture", "dpl_fixture", {
    fetcher: async () => new Response(JSON.stringify({ deploymentId: ids[Math.min(reads++, ids.length - 1)] }), { status: 200, headers: { "content-type": "application/json" } }),
    wait: async (ms) => { clock += ms; }, now: () => clock, windowMs: 90_000,
  });
  assert.equal(reads, 3);
  assert.ok(clock <= 90_000);
});

test("alias polling gives up at the window and never retries an authorization failure", async () => {
  let reads = 0;
  let clock = 0;
  await assert.rejects(
    waitForAlias(goodLink, "fixture", "dpl_fixture", {
      fetcher: async () => { reads++; return new Response(JSON.stringify({ deploymentId: "dpl_previous" }), { status: 200, headers: { "content-type": "application/json" } }); },
      wait: async (ms) => { clock += ms; }, now: () => clock, windowMs: 30_000,
    }),
    /alias did not move/,
  );
  assert.ok(clock <= 30_000, `waits stay inside the window, waited ${clock}ms`);
  assert.ok(reads >= 3);

  let forbidden = 0;
  await assert.rejects(
    waitForAlias(goodLink, "fixture", "dpl_fixture", {
      fetcher: async () => { forbidden++; return new Response("{}", { status: 403, headers: { "content-type": "application/json" } }); },
      wait: async () => {}, now: () => 0, windowMs: 90_000,
    }),
    /authorization/,
  );
  assert.equal(forbidden, 1, "an authorization failure is never retried");
});

test("runtime verification retries a commit mismatch within its window, not an authorization failure", async () => {
  const replies = [json({ gitCommitFull: other }), json({ gitCommitFull: sha })];
  let requestsSeen = 0;
  let clock = 0;
  const fetcher = async () => {
    const reply = replies[Math.min(requestsSeen++, replies.length - 1)];
    return new Response(reply.body, { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  };
  await verifyRuntime("https://shorted-fixture.vercel.app", sha, {
    fetcher, wait: async (ms) => { clock += ms; }, now: () => clock, windowMs: 90_000,
  });
  assert.equal(requestsSeen, 2, "one stale read, then the exact commit");

  let forbidden = 0;
  await assert.rejects(
    verifyRuntime("https://shorted-fixture.vercel.app", sha, {
      fetcher: async () => { forbidden++; return new Response("{}", { status: 403, headers: { "content-type": "application/json" } }); },
      wait: async () => {}, now: () => 0, windowMs: 90_000,
    }),
    /authorization/,
  );
  assert.equal(forbidden, 1, "an authorization failure is never retried");
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
});

test("promotion re-decides, verifies the upload, promotes, and only then records that it promoted", () => {
  const steps = parse(workflowSource).jobs["deploy-vercel-prod"].steps;
  const promote = steps.find((s) => s.name === "Promote Vercel deployment to production");
  const run = promote.run;
  const gate = run.indexOf("check-promotion --gate");
  const verifyDeployment = run.indexOf("verify-deployment");
  const vercelPromote = run.indexOf("vercel promote");
  const recorded = run.indexOf('echo "promoted=true" >> "$GITHUB_OUTPUT"');
  assert.ok(gate > -1 && gate < verifyDeployment && verifyDeployment < vercelPromote && vercelPromote < recorded, "order: re-decide, verify upload, promote, record");
  assert.match(run, /if \[ "\$gate" -eq 2 \]/, "a skip exits successfully and promotes nothing");
  assert.ok(!run.includes("ls-remote"), "no main-moved refusal");
  assert.equal(promote.id, "vercel-promote");
});

test("post-promotion verification, ISR revalidation and priming key on the promoted output", () => {
  const steps = parse(workflowSource).jobs["deploy-vercel-prod"].steps;
  const verify = steps.find((s) => s.name === "Verify exact production web commit");
  assert.notEqual(verify["continue-on-error"], true, "a failed runtime check must still fail the job");
  assert.match(verify.if, /steps\.vercel-promote\.outputs\.promoted == 'true'/);
  assert.equal(verify.env.DEPLOYMENT_ID, "${{ steps.vercel-deploy.outputs.deployment-id }}");
  assert.equal(verify.env.VERCEL_TOKEN, "${{ secrets.VERCEL_TOKEN }}");
  for (const name of ["Revalidate ISR pages post-promote", "Prime static pages after promotion"]) {
    const found = steps.find((s) => s.name === name);
    assert.match(found.if, /!cancelled\(\)/, name);
    assert.match(found.if, /steps\.vercel-promote\.outputs\.promoted == 'true'/, name);
  }
  for (const name of ["Install production smoke browser", "Verify promoted production release"]) {
    assert.match(steps.find((s) => s.name === name).if, /steps\.vercel-promote\.outputs\.promoted == 'true'/, name);
  }
});

test("production promotion is serialised and never cancels a run in flight", () => {
  const job = parse(workflowSource).jobs["deploy-vercel-prod"];
  assert.deepEqual(job.concurrency, { group: "vercel-prod-promote", "cancel-in-progress": false });
  assert.deepEqual(job.needs, ["determine-environment", "validate-secrets", "terraform-apply", "run-tests"]);
});

test("the build pulls the project after npm ci and before vercel build", () => {
  const build = step("Build and upload production deployment");
  const install = build.indexOf("npm --prefix web ci");
  const pull = build.indexOf("vercel pull --yes --environment production");
  const compile = build.indexOf("vercel@54.10.2 vercel build");
  assert.ok(install > -1 && install < pull && pull < compile);
});

test("the portal provenance job installs root test dependencies before any test imports them", () => {
  const hygiene = parse(readFileSync(new URL("../../.github/workflows/repo-hygiene.yml", import.meta.url), "utf8"));
  const steps = hygiene.jobs["portal-content-provenance"].steps;
  const install = steps.findIndex((s) => s.name === "Install root test dependencies");
  const hygieneTests = steps.findIndex((s) => s.name === "Test repository hygiene tooling");
  assert.ok(install > -1 && install < hygieneTests);
  assert.equal(steps[install].run, "npm ci --ignore-scripts --no-audit --no-fund");
  assert.ok(hygiene.jobs["portal-content-provenance"]["timeout-minutes"] >= 12);
  const guards = steps.find((s) => s.name === "Production release guard contracts");
  assert.match(guards.run, /scripts\/tests\/vercel-release\.test\.mjs/);
});
