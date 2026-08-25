import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../ensure-secret.sh", import.meta.url).pathname;

// Run ensure-secret.sh with a PATH-shimmed `gcloud` whose per-subcommand
// behaviour is scripted. The shim records every invocation so tests can assert
// what was (and was NOT) attempted — the incident modes here are all about the
// script taking a mutating action on bad evidence.
function run({ describe, access, valueArg = "some-value" }) {
  const dir = mkdtempSync(join(tmpdir(), "ensure-secret-"));
  const calls = join(dir, "calls.log");
  const shim = `#!/usr/bin/env bash
echo "$*" >> "${calls}"
case "$1 $2" in
  "secrets describe") ${describe} ;;
  "secrets versions") ${access} ;;
  "secrets create") exit 0 ;;
  *) exit 0 ;;
esac
`;
  writeFileSync(join(dir, "gcloud"), shim);
  chmodSync(join(dir, "gcloud"), 0o755);
  try {
    const stdout = execFileSync("bash", [script, "MY_SECRET", valueArg], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GCP_PROJECT_ID: "test-project" },
      encoding: "utf8",
    });
    const log = existsSync(calls)
      ? execFileSync("cat", [calls], { encoding: "utf8" })
      : "";
    return { stdout, calls: log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a transient describe failure never attempts create (the PR #494 plan-job crash)", () => {
  // describe exits 1 WITHOUT NOT_FOUND — auth/network/quota, not a missing
  // secret. Creating here races an existing secret and fails the deploy.
  const { calls } = run({
    describe: 'echo "ERROR: (gcloud.secrets.describe) There was a problem refreshing your current auth tokens" >&2; exit 1',
    access: "exit 1",
  });
  assert.doesNotMatch(calls, /secrets create/, "must not create on unknown state");
  assert.doesNotMatch(calls, /versions add/, "must not version on unknown state");
});

test("a NOT_FOUND describe creates the secret", () => {
  const { calls } = run({
    describe: 'echo "ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [MY_SECRET] not found." >&2; exit 1',
    access: "exit 1",
  });
  assert.match(calls, /secrets create/);
});

test("an unchanged value adds no version", () => {
  const { calls, stdout } = run({
    describe: "exit 0",
    access: 'printf "%s" "some-value"; exit 0',
  });
  assert.doesNotMatch(calls, /versions add/);
  assert.match(stdout, /unchanged/);
});

test("a changed value adds a version, never a create", () => {
  const { calls } = run({
    describe: "exit 0",
    access: 'printf "%s" "old-value"; exit 0',
  });
  assert.match(calls, /versions add/);
  assert.doesNotMatch(calls, /secrets create/);
});
