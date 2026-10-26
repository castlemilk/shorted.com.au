import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const CLI_VERSION = "54.10.2";
export const NODE_VERSION = "24.22.1";
const project = "shorted-com-au";
const scope = "document-analyser";
const productionHost = "shorted.com.au";
const defaultWindowMs = 90_000;
const shaPattern = /^[a-f0-9]{40}$/;

export function pinnedCLI(packageRoot) {
  if (!packageRoot) {
    const binary = (process.env.PATH ?? "")
      .split(delimiter)
      .map((path) => join(path, "vercel"))
      .find((path) => existsSync(path));
    if (!binary)
      throw new Error(
        `Run the preflight through npm exec with Vercel ${CLI_VERSION}.`,
      );
    packageRoot = dirname(dirname(realpathSync(binary)));
  }
  const metadata = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  if (metadata.name !== "vercel" || metadata.version !== CLI_VERSION)
    throw new Error(`Release requires Vercel CLI ${CLI_VERSION}.`);
  return join(packageRoot, "dist/vc.js");
}

export function assertSource(expected, actual) {
  if (!shaPattern.test(expected ?? "") || expected !== actual) {
    throw new Error("Release SHA must exactly match the checked-out commit.");
  }
}

export function failureKind(result) {
  const message = `${result.code ?? ""} ${result.message ?? ""}`;
  if (/challenge[ _]required|fresh authentication/i.test(message))
    return "challenge";
  if (
    [401, 403].includes(result.status) ||
    /unauthorized|forbidden|invalid.token/i.test(message)
  )
    return "authorization";
  if (
    [429, 502, 503, 504].includes(result.status) ||
    /\b(EAI_AGAIN|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b/.test(message)
  )
    return "transient";
  return "failure";
}

// Only reads use this retry budget. Builds, uploads and promotions are never replayed here.
export async function boundedRead(read, { wait = delay } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await read();
    if (result.ok) return result.value;
    const kind = failureKind(result);
    if (kind === "transient" && attempt < 2) {
      await wait([1000, 3000][attempt]);
      continue;
    }
    if (kind === "challenge") {
      throw new Error(
        "Vercel blocked production environment access with an authentication challenge. A supported interactive challenge refreshes that CLI session, not the explicit CI token. The account owner must review the CI credential; replacement requires separate approval. CI will not retry this challenge or rebuild around it.",
      );
    }
    // Provider output can contain sensitive values. Keep only the classification.
    throw new Error(
      `Vercel read failed (${kind}); no build, upload or promotion was retried.`,
    );
  }
}

export function deploymentRecord(payload) {
  if (payload.status && payload.status !== "ok")
    throw new Error("Vercel upload did not succeed.");
  const deployment = payload.deployment ?? payload;
  const url = new URL(deployment.url);
  if (
    !/^dpl_[a-zA-Z0-9]+$/.test(deployment.id ?? "") ||
    deployment.readyState !== "READY" ||
    deployment.target !== "production" ||
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".vercel.app") ||
    url.origin !== deployment.url ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Upload must return one READY production deployment with a canonical Vercel URL.",
    );
  }
  return { id: deployment.id, url: url.origin };
}

export function assertDeployment(deployment, record, link, sha) {
  assertSource(sha, deployment.meta?.shortedCommitSha);
  if (
    deployment.id !== record.id ||
    `https://${deployment.url}` !== record.url ||
    deployment.name !== project ||
    deployment.projectId !== link.projectId ||
    deployment.ownerId !== link.orgId ||
    link.projectName !== project ||
    deployment.target !== "production" ||
    deployment.readyState !== "READY" ||
    deployment.aliasError ||
    ["failed", "canceled"].includes(deployment.checksConclusion) ||
    ["registered", "running"].includes(deployment.checksState) ||
    (deployment.checks?.["deployment-alias"] &&
      deployment.checks["deployment-alias"].state !== "succeeded")
  ) {
    throw new Error(
      "Deployment identity, project, target, readiness or checks do not match this release.",
    );
  }
}

export function assertRuntime(body, sha) {
  assertSource(sha, body.gitCommitFull);
}

// The runtime read targets an immutable deployment URL. It proves the built
// commit is served by THAT deployment. Which deployment production points at
// is a separate question, answered by the alias (productionAliasDeployment).
export function runtimeUrl(deploymentUrl, sha) {
  const url = new URL("/api/version", deploymentUrl);
  url.searchParams.set("release", sha);
  url.searchParams.set("probe", String(Date.now()));
  return url;
}

// Strict: a value that is not a non-negative integer falls back to the default.
export function runtimeWindowMs(value) {
  if (value === undefined || !/^\d+$/.test(value)) return defaultWindowMs;
  return Number(value);
}

export async function jsonRead(
  url,
  headers = {},
  fetcher = fetch,
  retryOptions,
) {
  return boundedRead(async () => {
    try {
      const response = await fetcher(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
      const body = await response.json().catch(() => undefined);
      return response.ok && body
        ? { ok: true, value: body }
        : {
            ok: false,
            status: response.status,
            code: body?.error?.code,
            message: body?.error?.message,
          };
    } catch (error) {
      return {
        ok: false,
        code:
          error.name === "TimeoutError"
            ? "ETIMEDOUT"
            : (error.cause?.code ?? error.code),
        message: error.name,
      };
    }
  }, retryOptions);
}

function currentSource() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  assertSource(process.env.GITHUB_SHA, result.stdout?.trim());
  for (const args of [
    ["diff", "--quiet"],
    ["diff", "--cached", "--quiet"],
  ]) {
    if (spawnSync("git", args).status !== 0)
      throw new Error("Release source has uncommitted tracked changes.");
  }
}

// The link file lives in the runner's temporary directory, outside the source
// tree. It is written by the preflight and read by the release decision and
// the post-promotion checks. The build's own pull also writes .vercel/.
function linkFilePath() {
  if (!process.env.RUNNER_TEMP)
    throw new Error("RUNNER_TEMP is required for the Vercel project link.");
  return join(process.env.RUNNER_TEMP, "shorted-vercel-link.json");
}

export function validateLink(link) {
  if (link.projectName !== project || !link.projectId || !link.orgId)
    throw new Error("Vercel project link does not match Shorted production.");
  return {
    projectName: link.projectName,
    projectId: link.projectId,
    orgId: link.orgId,
  };
}

function readLink() {
  const path = existsSync(".vercel/project.json")
    ? ".vercel/project.json"
    : linkFilePath();
  return validateLink(JSON.parse(readFileSync(path, "utf8")));
}

async function probeAccess(cli, cwd) {
  await boundedRead(() => {
    // Run the Node entry point directly. Timing out an npm wrapper could leave
    // its CLI child alive while the next read attempt starts.
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "pull",
        "--yes",
        "--environment",
        "production",
        "--project",
        project,
        "--scope",
        scope,
        "--non-interactive",
      ],
      {
        encoding: "utf8",
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CI: "1", FORCE_TTY: "0" },
      },
    );
    return {
      ok: result.status === 0,
      code: result.error?.code,
      message: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    };
  });
}

async function preflight() {
  process.umask(0o077);
  currentSource();
  if (process.versions.node !== NODE_VERSION)
    throw new Error(`Release requires Node ${NODE_VERSION}.`);
  if (!process.env.VERCEL_TOKEN)
    throw new Error("The existing CI VERCEL_TOKEN is unavailable.");
  const cli = pinnedCLI();
  // The access probe pulls into a throwaway directory under RUNNER_TEMP, so
  // no link or environment file exists in the source tree before npm ci. Only
  // the validated project link is kept, outside the repository. The build
  // pulls for real after npm ci.
  if (!process.env.RUNNER_TEMP)
    throw new Error("RUNNER_TEMP is required for the Vercel access probe.");
  const probe = mkdtempSync(join(process.env.RUNNER_TEMP, "vercel-probe-"));
  try {
    await probeAccess(cli, probe);
    const link = validateLink(
      JSON.parse(readFileSync(join(probe, ".vercel/project.json"), "utf8")),
    );
    writeFileSync(linkFilePath(), JSON.stringify(link), { mode: 0o600 });
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  console.log(
    `Production preflight passed for ${process.env.GITHUB_SHA}; Vercel CLI ${CLI_VERSION}, Node ${NODE_VERSION}.`,
  );
}

// Production's alias is the source of truth for what the apex serves.
export function aliasUrl(orgId) {
  const url = new URL(`https://api.vercel.com/v4/aliases/${productionHost}`);
  url.searchParams.set("teamId", orgId);
  return url;
}

export function deploymentUrl(id, orgId) {
  const url = new URL(`https://api.vercel.com/v13/deployments/${id}`);
  url.searchParams.set("teamId", orgId);
  return url;
}

function vercelAuth(token) {
  return { Authorization: `Bearer ${token}` };
}

// Returns the deployment the production alias points at, after checking that
// it belongs to this project and is a READY production deployment. Any read
// failure throws: the caller treats it as fail closed.
export async function productionAliasDeployment(link, token, fetcher = fetch) {
  const alias = await jsonRead(aliasUrl(link.orgId), vercelAuth(token), fetcher);
  if (!/^dpl_[a-zA-Z0-9]+$/.test(alias.deploymentId ?? ""))
    throw new Error("Production alias did not name a deployment.");
  const deployment = await jsonRead(
    deploymentUrl(alias.deploymentId, link.orgId),
    vercelAuth(token),
    fetcher,
  );
  const url = new URL(`https://${deployment.url}`);
  if (
    deployment.projectId !== link.projectId ||
    deployment.target !== "production" ||
    deployment.readyState !== "READY" ||
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".vercel.app")
  )
    throw new Error(
      "Production alias does not point at a READY production deployment of this project.",
    );
  return { id: alias.deploymentId, url: url.origin };
}

export function isFullSha(value) {
  return shaPattern.test(value ?? "");
}

// Decides from the commit production is serving.
//  - A full commit equal to this release: promote (idempotent).
//  - A full commit whose GitHub comparison says "ahead" (live descends from
//    this release): skip. A newer release already shipped.
//  - Anything else with a full commit (behind, diverged): promote.
//  - No full commit at all (a legacy or rolled-back build that predates commit
//    identity, or "local"): promote. The caller logs a warning. Only a failed
//    read ever fails closed.
export function promotionDecision(liveSha, releaseSha, comparison) {
  if (!isFullSha(liveSha)) return "promote";
  if (liveSha === releaseSha) return "promote";
  if (!comparison)
    throw new Error("A comparison is required for a different live commit.");
  return comparison.status === "ahead" ? "skip" : "promote";
}

// Polls the alias until it points at this upload. `vercel promote` can exit 0
// without moving the alias (no promotion in progress, a skipped promotion, or
// a rolling release at its first stage), so the alias is the only proof.
export async function waitForAlias(
  link,
  token,
  expectedId,
  { fetcher = fetch, wait = delay, windowMs = defaultWindowMs, now = Date.now } = {},
) {
  const deadline = now() + windowMs;
  let pause = 3_000;
  for (;;) {
    const alias = await jsonRead(aliasUrl(link.orgId), vercelAuth(token), fetcher);
    if (alias.deploymentId === expectedId) return;
    if (now() + pause > deadline)
      throw new Error(
        "Production alias did not move to this release within the verification window.",
      );
    await wait(pause);
    pause = Math.min(pause * 2, 15_000);
  }
}

// Re-reads the deployment's /api/version on mismatch only, for propagation.
// Authorization and transport failures keep their single-attempt semantics.
export async function verifyRuntime(
  deploymentOrigin,
  sha,
  { fetcher = fetch, wait = delay, windowMs = defaultWindowMs, now = Date.now } = {},
) {
  const deadline = now() + windowMs;
  let pause = 3_000;
  for (;;) {
    try {
      assertRuntime(
        await jsonRead(
          runtimeUrl(deploymentOrigin, sha),
          { "Cache-Control": "no-cache" },
          fetcher,
        ),
        sha,
      );
      return;
    } catch (error) {
      if (
        !/Release SHA must exactly match/.test(error.message) ||
        now() + pause > deadline
      )
        throw error;
    }
    await wait(pause);
    pause = Math.min(pause * 2, 15_000);
  }
}

async function checkPromotion({ gate }) {
  currentSource();
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("The existing CI VERCEL_TOKEN is unavailable.");
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("GITHUB_REPOSITORY must name the repository.");
  const sha = process.env.GITHUB_SHA;
  const link = readLink();
  const live = await productionAliasDeployment(link, token);
  const runtime = await jsonRead(runtimeUrl(live.url, sha), {
    "Cache-Control": "no-cache",
  });
  const liveSha = runtime.gitCommitFull;
  let comparison;
  if (!isFullSha(liveSha)) {
    console.log(
      `::warning::Production (${live.id}) reports no full commit identity (${liveSha ?? "missing"}); promoting without a descendant check.`,
    );
  } else if (liveSha !== sha) {
    const headers = { Accept: "application/vnd.github+json" };
    if (process.env.GH_TOKEN)
      headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    comparison = await jsonRead(
      `https://api.github.com/repos/${repository}/compare/${sha}...${liveSha}`,
      headers,
    );
  }
  const decision = promotionDecision(liveSha, sha, comparison);
  if (gate) {
    if (decision === "skip") {
      console.log(
        `Production already serves a newer descendant (${liveSha}) of ${sha}; not promoting. This is not a failure.`,
      );
      process.exitCode = 2;
      return;
    }
    return;
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `promote=${decision === "promote"}\n`,
    );
  console.log(
    decision === "promote"
      ? `Production serves ${liveSha ?? "no full commit"}; promoting ${sha}.`
      : `Production already serves a newer descendant (${liveSha}) of ${sha}; skipping promotion. This is not a failure.`,
  );
}

async function verifyProduction() {
  currentSource();
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("The existing CI VERCEL_TOKEN is unavailable.");
  const deployment = new URL(process.env.DEPLOYMENT_URL ?? "");
  if (
    !/^dpl_[a-zA-Z0-9]+$/.test(process.env.DEPLOYMENT_ID ?? "") ||
    deployment.protocol !== "https:" ||
    !deployment.hostname.endsWith(".vercel.app") ||
    deployment.origin !== process.env.DEPLOYMENT_URL
  )
    throw new Error(
      "Verification needs the uploaded deployment id and its canonical Vercel URL.",
    );
  const link = readLink();
  const windowMs = runtimeWindowMs(process.env.RUNTIME_VERIFY_WINDOW_MS);
  await waitForAlias(link, token, process.env.DEPLOYMENT_ID, { windowMs });
  await verifyRuntime(deployment.origin, process.env.GITHUB_SHA, { windowMs });
  console.log(
    `Production alias serves ${process.env.DEPLOYMENT_ID} and its runtime reports ${process.env.GITHUB_SHA}.`,
  );
}

async function main() {
  const [operation, input, flag] = process.argv.slice(2);
  if (operation === "preflight") return preflight();
  if (operation === "check-promotion")
    return checkPromotion({ gate: input === "--gate" || flag === "--gate" });
  if (operation === "record") {
    const record = deploymentRecord(JSON.parse(readFileSync(input, "utf8")));
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `deployment-id=${record.id}\ndeployment-url=${record.url}\n`,
    );
    return;
  }
  if (operation === "verify-deployment") {
    currentSource();
    const link = readLink();
    const record = {
      id: process.env.DEPLOYMENT_ID,
      url: process.env.DEPLOYMENT_URL,
    };
    if (
      !/^dpl_[a-zA-Z0-9]+$/.test(record.id ?? "") ||
      !process.env.VERCEL_TOKEN
    )
      throw new Error(
        "Deployment receipt or existing CI token is unavailable.",
      );
    const deployment = await jsonRead(
      deploymentUrl(record.id, link.orgId),
      vercelAuth(process.env.VERCEL_TOKEN),
    );
    assertDeployment(deployment, record, link, process.env.GITHUB_SHA);
    console.log(
      `Verified READY production deployment for ${process.env.GITHUB_SHA}.`,
    );
    return;
  }
  if (operation === "verify-production") return verifyProduction();
  throw new Error(
    "Expected preflight, check-promotion, record, verify-deployment or verify-production.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = process.exitCode || 1;
  });
}
