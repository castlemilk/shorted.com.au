import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  readFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(directory, "../..");
const results = path.join(webRoot, "test-results/community-integration");
const projectId = "demo-shorted-community-test";
const database = "shorted_community_test";
const emulatorSha256 =
  "9d43599ed6151199e8d604dc87fac51218e49e5f3a48519b1ae560bbe5e3382d";
const children = new Set();
let container;
let cleaning;
const cleanupErrors = [];

// Do not pass credentials, cloud settings, telemetry exporters or a developer's
// NODE_OPTIONS into the app/test children. Install/download steps run separately.
const localEnv = Object.fromEntries(
  ["PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "CI"]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
const dockerEnv = {
  ...localEnv,
  DOCKER_HOST: process.env.DOCKER_HOST || "unix:///var/run/docker.sock",
};

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function docker(args, timeout = 60_000) {
  return execFileSync("docker", args, {
    env: dockerEnv,
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function start(command, args, name, env = localEnv) {
  const output = createWriteStream(path.join(results, `${name}.log`));
  const child = spawn(command, args, {
    cwd: webRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.add(child);
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  child.once("exit", () => {
    children.delete(child);
    output.end();
  });
  child.once("error", () => output.end());
  return child;
}

async function waitForService(url, child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode)
      throw new Error(`Service exited before readiness: ${url}`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      /* service is still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Service did not become ready within ${timeoutMs}ms: ${url}`);
}

async function runChild(args, name, env, timeoutMs = 300_000) {
  const child = start(process.execPath, args, name, env);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
      reject(new Error(`${name} exceeded ${timeoutMs}ms; inspect ${name}.log`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      // The verifier normally stops Next itself. Reap any remaining member of
      // this run's process group even if the verifier exited unexpectedly.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* the group already exited */
      }
      if (code === 0) resolve();
      else
        reject(
          new Error(`${name} failed (${code ?? signal}); inspect ${name}.log`),
        );
    });
  });
}

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    const running = [...children];
    for (const child of running) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (const child of running) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
    if (container) {
      try {
        docker(["rm", "--force", "--volumes", container], 15_000);
      } catch (error) {
        cleanupErrors.push(error.message);
        console.error("Disposable container cleanup failed:", error.message);
      }
    }
  })();
  return cleaning;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });
}

await mkdir(results, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  head: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: webRoot,
    encoding: "utf8",
  }).trim(),
  worktreeDirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: webRoot,
      encoding: "utf8",
    }).trim(),
  ),
  status: "failed",
  drivers: [],
};
try {
  for (const name of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
  ]) {
    assert(
      !existsSync(path.join(webRoot, name)),
      `Refusing to load ${name}; run in an isolated checkout without app env files`,
    );
  }
  assert(
    /^unix:\/\//.test(dockerEnv.DOCKER_HOST) ||
      /^tcp:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(dockerEnv.DOCKER_HOST),
    "Docker must use a local daemon",
  );
  docker(["info", "--format", "{{.ServerVersion}}"], 15_000);
  const jar = process.env.FIRESTORE_EMULATOR_JAR;
  assert(
    jar && existsSync(jar),
    "FIRESTORE_EMULATOR_JAR must point to the pinned official 1.19.8 emulator; see README",
  );
  assert.equal(
    createHash("sha256").update(readFileSync(jar)).digest("hex"),
    emulatorSha256,
    "Firestore emulator checksum mismatch",
  );

  container = `shorted-community-${randomUUID()}`;
  // Record the exact owned name before creation, so the workflow can clean up
  // even if this Node process is killed before its finally/signal handler runs.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `container_name=${container}\n`);
  }
  const password = randomUUID();
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--label",
    "shorted.test=community-integration",
    "--publish",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,size=256m",
    "--env",
    `POSTGRES_DB=${database}`,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "postgres:15-alpine",
  ]);
  const mapping = docker(["port", container, "5432/tcp"]);
  assert.match(mapping, /^127\.0\.0\.1:\d+$/);
  const databaseUrl = `postgresql://postgres:${password}@${mapping}/${database}`;
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1000,
  });
  try {
    const deadline = Date.now() + 45_000;
    while (true) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await pool.query(
      readFileSync(
        path.resolve(
          webRoot,
          "../services/migrations/000072_add_community_postgres_tables.up.sql",
        ),
        "utf8",
      ),
    );
  } finally {
    await pool.end();
  }

  const firestorePort = await freePort();
  const emulator = start(
    "java",
    [
      "-Xmx512m",
      "-jar",
      jar,
      "--host",
      "127.0.0.1",
      "--port",
      String(firestorePort),
      "--project_id",
      projectId,
      "--single_project_mode",
      "true",
      "--rules",
      path.join(webRoot, "firestore.rules"),
    ],
    "firestore-emulator",
  );
  await waitForService(`http://127.0.0.1:${firestorePort}`, emulator);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  for (const driver of ["postgres", "firestore"]) {
    console.log(`Running real ${driver} community adapter and browser journey`);
    const env = {
      ...localEnv,
      NODE_ENV: "development",
      COMMUNITY_STORE_DRIVER: driver,
      COMMUNITY_TEST_DATABASE_URL: databaseUrl,
      DATABASE_URL: driver === "postgres" ? databaseUrl : "",
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${firestorePort}`,
      AUTH_FIREBASE_PROJECT_ID: projectId,
      AUTH_FIREBASE_CLIENT_EMAIL:
        "synthetic@demo-shorted-community-test.iam.gserviceaccount.com",
      AUTH_FIREBASE_PRIVATE_KEY: privateKey,
      COMMUNITY_TEST_RESULTS: results,
      SKIP_ENV_VALIDATION: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      ALLOW_E2E_AUTH: "true",
      E2E_TEST_EMAIL: "community-integration@example.test",
      E2E_TEST_PASSWORD: randomUUID(),
      NEXTAUTH_SECRET: randomUUID(),
      NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(
        directory,
        "font-fixture.cjs",
      ),
      NODE_OPTIONS: `--require=${path.join(directory, "local-network-only.cjs")}`,
    };
    await runChild(
      ["--import", "tsx", path.join(directory, "verify.ts")],
      driver,
      env,
    );
    report.drivers.push(driver);
  }
  report.status = "passed";
} catch (error) {
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
  if (cleanupErrors.length) {
    report.status = "failed";
    report.cleanupErrors = cleanupErrors;
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(results, "summary.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Community integration ${report.status}; evidence: ${results}`);
}
