import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const CLI_VERSION = "54.10.2";
export const NODE_VERSION = "24.22.1";
const project = "shorted-com-au";
const scope = "document-analyser";
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

// The runtime check reads the deployment's own *.vercel.app URL. The apex sits
// behind Cloudflare's managed challenge, which a CI runner cannot pass.
export function runtimeUrl(deploymentUrl, sha) {
  const url = new URL("/api/version", deploymentUrl);
  url.searchParams.set("release", sha);
  url.searchParams.set("probe", String(Date.now()));
  return url;
}

// Re-reads on commit mismatch only: after `vercel promote` the new deployment
// can take a moment to serve its own commit. Authorization and transport
// failures keep their single-attempt semantics from boundedRead.
export async function verifyRuntime(
  deploymentUrl,
  sha,
  { fetcher = fetch, wait = delay, windowMs = 90_000, now = Date.now } = {},
) {
  const deadline = now() + windowMs;
  let pause = 3_000;
  for (;;) {
    try {
      assertRuntime(
        await jsonRead(
          runtimeUrl(deploymentUrl, sha),
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

// What production serves decides whether this release may promote. A live
// commit that descends from this one means a newer release already shipped
// (for example a manual re-run of an old run): skip, do not roll back.
export function promotionDecision(liveSha, releaseSha, comparison) {
  if (!shaPattern.test(liveSha ?? ""))
    throw new Error(
      "Production did not report a full commit; refusing to promote blind.",
    );
  if (liveSha === releaseSha) return "promote";
  // GitHub compare: "ahead" means the head (live) descends from the base (release).
  return comparison?.status === "ahead" ? "skip" : "promote";
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

async function preflight() {
  process.umask(0o077);
  currentSource();
  if (process.versions.node !== NODE_VERSION)
    throw new Error(`Release requires Node ${NODE_VERSION}.`);
  if (!process.env.VERCEL_TOKEN)
    throw new Error("The existing CI VERCEL_TOKEN is unavailable.");
  const cli = pinnedCLI();
  // The access probe runs in a throwaway directory. The pull writes a project
  // link and an environment file; neither may exist in the source tree before
  // npm ci, where install scripts could read them. The build pulls for real
  // after npm ci.
  const probe = mkdtempSync(join(tmpdir(), "vercel-probe-"));
  try {
    await probeAccess(cli, probe);
    const link = JSON.parse(
      readFileSync(join(probe, ".vercel/project.json"), "utf8"),
    );
    if (link.projectName !== project || !link.projectId || !link.orgId)
      throw new Error("Vercel project link does not match Shorted production.");
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  console.log(
    `Production preflight passed for ${process.env.GITHUB_SHA}; Vercel CLI ${CLI_VERSION}, Node ${NODE_VERSION}.`,
  );
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

async function checkPromotion() {
  currentSource();
  if (!process.env.VERCEL_TOKEN)
    throw new Error("The existing CI VERCEL_TOKEN is unavailable.");
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("GITHUB_REPOSITORY must name the repository.");
  const listing = new URL("https://api.vercel.com/v6/deployments");
  listing.searchParams.set("app", project);
  listing.searchParams.set("slug", scope);
  listing.searchParams.set("target", "production");
  listing.searchParams.set("limit", "5");
  const listed = await jsonRead(listing, {
    Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
  });
  const current = (listed.deployments ?? []).find(
    (deployment) =>
      deployment.target === "production" && deployment.readyState === "READY",
  );
  if (!current?.url)
    throw new Error("No READY production deployment to compare against.");
  const live = new URL(`https://${current.url}`);
  if (live.protocol !== "https:" || !live.hostname.endsWith(".vercel.app"))
    throw new Error("Production deployment URL is not a canonical Vercel URL.");
  const runtime = await jsonRead(runtimeUrl(live.origin, process.env.GITHUB_SHA), {
    "Cache-Control": "no-cache",
  });
  const sha = process.env.GITHUB_SHA;
  let comparison;
  if (runtime.gitCommitFull && runtime.gitCommitFull !== sha) {
    if (!shaPattern.test(runtime.gitCommitFull))
      throw new Error(
        "Production did not report a full commit; refusing to promote blind.",
      );
    comparison = await jsonRead(
      `https://api.github.com/repos/${repository}/compare/${sha}...${runtime.gitCommitFull}`,
      {
        Accept: "application/vnd.github+json",
        ...(process.env.GH_TOKEN
          ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
          : {}),
      },
    );
  }
  const decision = promotionDecision(runtime.gitCommitFull, sha, comparison);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `promote=${decision === "promote"}\n`,
    );
  console.log(
    decision === "promote"
      ? `Production serves ${runtime.gitCommitFull}; promoting ${sha}.`
      : `Production already serves a newer descendant (${runtime.gitCommitFull}) of ${sha}; skipping promotion. This is not a failure.`,
  );
}

async function main() {
  const [operation, input] = process.argv.slice(2);
  if (operation === "preflight") return preflight();
  if (operation === "check-promotion") return checkPromotion();
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
    const link = JSON.parse(readFileSync(".vercel/project.json", "utf8"));
    const record = {
      id: process.env.DEPLOYMENT_ID,
      url: process.env.DEPLOYMENT_URL,
    };
    if (
      !/^dpl_[a-zA-Z0-9]+$/.test(record.id ?? "") ||
      !link.orgId ||
      !process.env.VERCEL_TOKEN
    )
      throw new Error(
        "Deployment receipt, project link or existing CI token is unavailable.",
      );
    const url = new URL(`https://api.vercel.com/v13/deployments/${record.id}`);
    url.searchParams.set("teamId", link.orgId);
    const deployment = await jsonRead(url, {
      Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
    });
    assertDeployment(deployment, record, link, process.env.GITHUB_SHA);
    console.log(
      `Verified READY production deployment for ${process.env.GITHUB_SHA}.`,
    );
    return;
  }
  if (operation === "verify-production") {
    currentSource();
    const deploymentUrl = new URL(process.env.DEPLOYMENT_URL ?? "");
    if (
      deploymentUrl.protocol !== "https:" ||
      !deploymentUrl.hostname.endsWith(".vercel.app") ||
      deploymentUrl.origin !== process.env.DEPLOYMENT_URL
    )
      throw new Error("Verification needs the promoted canonical Vercel URL.");
    await verifyRuntime(deploymentUrl.origin, process.env.GITHUB_SHA, {
      windowMs: Number(process.env.RUNTIME_VERIFY_WINDOW_MS ?? 90_000),
    });
    console.log(`Production runtime accepted ${process.env.GITHUB_SHA}.`);
    return;
  }
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
    process.exitCode = 1;
  });
}
