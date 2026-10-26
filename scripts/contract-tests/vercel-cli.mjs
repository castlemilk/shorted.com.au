// Run via: npm exec --yes --ignore-scripts --package=vercel@54.10.2 -- node scripts/contract-tests/vercel-cli.mjs
// The actual CLI runs against a loopback fake API. No account credentials or production APIs are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_VERSION,
  pinnedCLI,
  deploymentRecord,
  assertDeployment,
} from "../vercel-release.mjs";

const cli = pinnedCLI(process.env.VERCEL_CLI_CONTRACT_PACKAGE);
const scratch = mkdtempSync(join(tmpdir(), "shorted-vercel-contract-"));
const config = join(scratch, "cli-config");
const sha = "a".repeat(40);
const team = {
  id: "team_fixture",
  slug: "document-analyser",
  name: "Fixture",
  membership: { role: "OWNER", confirmed: true },
};
const project = {
  id: "prj_fixture",
  name: "shorted-com-au",
  accountId: team.id,
  framework: null,
  rootDirectory: null,
  nodeVersion: "24.x",
};
let deployment = {
  id: "dpl_fixture",
  url: "shorted-fixture.vercel.app",
  name: project.name,
  ownerId: team.id,
  projectId: project.id,
  target: "production",
  readyState: "READY",
  status: "READY",
  version: 2,
  createdAt: Date.now(),
  buildingAt: Date.now(),
  regions: ["iad1"],
  alias: [],
  aliasAssigned: true,
};
let challenge = false;
const requests = [];
let createBody;

// The CLI's API client selects an HTTPS agent even for its test --api URL.
// Adapt only that transport to HTTP, and refuse every non-loopback connection.
const adapter = join(scratch, "loopback-agent.mjs");
writeFileSync(
  adapter,
  `import http from 'node:http'; import https from 'node:https'; import {syncBuiltinESMExports} from 'node:module';
https.Agent = class extends http.Agent { createConnection(options, callback) {
if (options.host !== '127.0.0.1' && options.hostname !== '127.0.0.1') throw new Error('Fixture transport only permits loopback');
return super.createConnection(options, callback); }}; syncBuiltinESMExports();`,
);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : undefined;
  requests.push({ method: req.method, path: url.pathname });
  assert.equal(req.headers.authorization, "Bearer fixturetoken");
  let response;
  if (url.pathname === "/v2/user")
    response = {
      user: {
        uid: "fixture_user",
        username: "fixture",
        email: "fixture@example.invalid",
      },
    };
  else if (/^\/v[12]\/teams$/.test(url.pathname))
    response = { teams: [team], pagination: { count: 1 } };
  else if (url.pathname === "/v2/teams/team_fixture") response = team;
  else if (
    /^\/v\d+\/projects\/(prj_fixture|shorted-com-au)$/.test(url.pathname)
  )
    response = project;
  else if (url.pathname === "/v3/env/pull/prj_fixture/production") {
    if (challenge) {
      res.statusCode = 403;
      response = {
        error: { code: "challenge_required", message: "Challenge required" },
      };
    } else response = { env: { FIXTURE_ENV: "fixture" }, typeHints: {} };
  } else if (
    req.method === "POST" &&
    /^\/v\d+\/(now\/)?deployments$/.test(url.pathname)
  ) {
    createBody = body;
    deployment = { ...deployment, meta: body.meta };
    response = deployment;
  } else if (
    req.method === "GET" &&
    /^\/v\d+\/(now\/)?deployments\/dpl_fixture$/.test(url.pathname)
  )
    response = deployment;
  else if (url.pathname.endsWith("/builds")) response = { builds: [] };
  else if (url.pathname.endsWith("/events")) response = [];
  else {
    res.statusCode = 404;
    response = {
      error: { code: "fixture_unknown_route", message: url.pathname },
    };
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(response));
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  const cwd = join(scratch, "project");
  mkdirSync(join(cwd, ".vercel/output/static"), { recursive: true });
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "shorted-cli-fixture",
      version: "0.0.0",
      private: true,
      engines: { node: "24.x" },
    }),
  );
  writeFileSync(
    join(cwd, ".vercel/project.json"),
    JSON.stringify({ projectId: project.id, orgId: team.id }),
  );
  writeFileSync(
    join(cwd, ".vercel/output/config.json"),
    JSON.stringify({ version: 3 }),
  );
  writeFileSync(
    join(cwd, ".vercel/output/builds.json"),
    JSON.stringify({ target: "production" }),
  );
  writeFileSync(join(cwd, ".vercel/output/static/index.html"), "fixture");
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    VERCEL_TOKEN: "fixturetoken",
    FIXTURE_RUNTIME_VALUE: "fixture-value",
    VERCEL_TELEMETRY_DISABLED: "1",
    NO_UPDATE_NOTIFIER: "1",
    CI: "1",
    FORCE_TTY: "0",
    NODE_OPTIONS: `--import=${adapter}`,
  });
  async function run(args) {
    const child = spawn(
      process.execPath,
      [cli, ...args, "--global-config", config, "--api", api],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const status = await new Promise((resolve) => child.on("exit", resolve));
    clearTimeout(timer);
    return { status, stdout, stderr };
  }
  const pullArgs = [
    "pull",
    "--yes",
    "--environment",
    "production",
    "--project",
    project.name,
    "--scope",
    team.slug,
    "--non-interactive",
  ];
  const pulled = await run(pullArgs);
  assert.equal(pulled.status, 0, pulled.stderr);
  const link = JSON.parse(
    readFileSync(join(cwd, ".vercel/project.json"), "utf8"),
  );
  assert.equal(link.projectId, project.id);
  assert.equal(link.orgId, team.id);
  assert.equal(link.projectName, project.name);

  const args = [
    "deploy",
    "--prebuilt",
    "--yes",
    "--target",
    "production",
    "--skip-domain",
    "--scope",
    team.slug,
    "--archive=tgz",
    "--json",
    "--non-interactive",
    "--env",
    "FIXTURE_RUNTIME_VALUE",
    "--meta",
    `shortedCommitSha=${sha}`,
  ];
  assert.ok(
    !args.includes(env.VERCEL_TOKEN) &&
      !args.includes(env.FIXTURE_RUNTIME_VALUE),
  );
  const uploaded = await run(args);
  assert.equal(uploaded.status, 0, uploaded.stderr);
  assert.equal(createBody.env.FIXTURE_RUNTIME_VALUE, env.FIXTURE_RUNTIME_VALUE);
  assert.equal(createBody.target, "production");
  assert.equal(createBody.autoAssignCustomDomains, false);
  const payload = JSON.parse(uploaded.stdout);
  assert.equal(payload.status, "ok");
  assertDeployment(deployment, deploymentRecord(payload), link, sha);
  assert.ok(!uploaded.stderr.includes(env.FIXTURE_RUNTIME_VALUE));

  challenge = true;
  const countBefore = requests.filter((req) =>
    req.path.includes("/env/pull/"),
  ).length;
  const challenged = await run(pullArgs);
  assert.equal(challenged.status, 1);
  assert.match(challenged.stderr, /Challenge required/);
  assert.equal(
    requests.filter((req) => req.path.includes("/env/pull/")).length -
      countBefore,
    1,
  );
  assert.ok(!requests.some((req) => /oauth|device|login/.test(req.path)));
  assert.ok(
    !existsSync(join(config, "auth.json")),
    "Explicit fixture token must not create stored login credentials",
  );
  assert.equal(
    requests.filter((req) => req.method === "POST").length,
    1,
    "Only the single fake deployment upload may mutate the fake API",
  );
  console.log(
    `Vercel ${CLI_VERSION} real CLI contracts passed: noninteractive pull/link, bare env inheritance, production receipt, terminal challenge.`,
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
