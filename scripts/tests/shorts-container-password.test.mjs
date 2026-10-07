import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
// Refuse to execute a legacy target, including through the fake Docker CLI.
// A boolean assertion keeps source values out of failure diagnostics.
const makefile = readFileSync(join(repoRoot, "services/Makefile"), "utf8");
assert.equal(/^\s*-e APP_STORE_POSTGRES_PASSWORD=\S+/m.test(makefile), false,
  "remove literal Docker password assignments before exercising this target");

function runTarget(t, password, dryRun = false) {
  const dir = mkdtempSync(join(tmpdir(), "shorts-password-input-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "docker-call");
  const docker = join(dir, "docker");
  writeFileSync(docker, `#!/bin/sh
printf '%s\\n' "$@" > "$CALL_LOG"
printf '%s' "$APP_STORE_POSTGRES_PASSWORD" > "$CALL_LOG.env"
exit 0
`);
  chmodSync(docker, 0o755);
  const env = { PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log };
  if (password !== undefined) env.APP_STORE_POSTGRES_PASSWORD = password;
  const result = spawnSync("make", ["--no-print-directory", ...(dryRun ? ["-n"] : []), "-C", join(repoRoot, "services"), "run.docker.shorts.superbase", "SHORTS_IMAGE=fixture-image", "SHORTS_VERSION=fixture-version"], {
    encoding: "utf8", timeout: 10_000, env,
  });
  return { result, log };
}

for (const value of [undefined, ""]) {
  test(`missing ${value === undefined ? "unset" : "empty"} password fails before Docker`, (t) => {
    const { result, log } = runTarget(t, value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APP_STORE_POSTGRES_PASSWORD is required/);
    assert.equal(existsSync(log), false);
  });
}

test("caller environment reaches Docker without putting the value in argv or output", (t) => {
  const password = "synthetic-$value 'quote' with spaces";
  const { result, log } = runTarget(t, password);
  assert.equal(result.status, 0, result.stderr);
  const args = readFileSync(log, "utf8").trim().split("\n");
  const flag = args.indexOf("APP_STORE_POSTGRES_PASSWORD");
  assert.ok(flag > 0);
  assert.equal(args[flag - 1], "-e");
  assert.ok(args.includes("fixture-image:fixture-version"));
  assert.equal(readFileSync(`${log}.env`, "utf8"), password);
  assert.ok(!args.join("\n").includes(password));
  assert.ok(!(result.stdout + result.stderr).includes(password));
});

test("make dry-run contains the environment name only", (t) => {
  const password = "synthetic-dry-run-password";
  const { result, log } = runTarget(t, password, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /-e APP_STORE_POSTGRES_PASSWORD \\/);
  assert.ok(!(result.stdout + result.stderr).includes(password));
  assert.equal(existsSync(log), false);
});
