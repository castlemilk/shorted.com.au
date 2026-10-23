import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../ensure-secret.sh", import.meta.url).pathname;

// Run ensure-secret.sh with a PATH-shimmed `gcloud` whose per-subcommand
// behaviour is scripted. The shim records every invocation so tests can assert
// what was (and was NOT) attempted — the incident modes here are all about the
// script taking a mutating action on bad evidence.
function run({ describe, access, valueArg = "some-value", env = {} }) {
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
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GCP_PROJECT_ID: "test-project", ...env },
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

test("create-only mode never versions an existing secret (the plan-vs-apply fight)", () => {
  const { calls, stdout } = run({
    describe: "exit 0",
    access: 'printf "%s" "old-value"; exit 0',
    env: { ENSURE_SECRET_CREATE_ONLY: "1" },
  });
  assert.doesNotMatch(calls, /versions add/);
  assert.doesNotMatch(calls, /versions access/, "must not even read the value");
  assert.match(stdout, /create-only/);
});

test("create-only mode still creates a missing secret", () => {
  const { calls } = run({
    describe: 'echo "ERROR: NOT_FOUND: Secret [MY_SECRET] not found." >&2; exit 1',
    access: "exit 1",
    env: { ENSURE_SECRET_CREATE_ONLY: "1" },
  });
  assert.match(calls, /secrets create/);
});

// Trailing CR/LF are not content. A value of only CR/LF is empty, so it is skipped
// like an unset value. The emptiness check must run after the strip, or a CR-only
// value would be versioned as 0 bytes.
test("a value of only CR or LF is treated as not set: never versioned, never created", () => {
  for (const valueArg of ["\r", "\n", "\r\n"]) {
    const existing = run({
      describe: "exit 0",
      access: 'printf "%s" "old-value"; exit 0',
      valueArg,
    });
    assert.doesNotMatch(existing.calls, /versions add/, `${JSON.stringify(valueArg)} must not add a version`);
    assert.match(existing.stdout, /not set, skipping/, `${JSON.stringify(valueArg)} must skip`);

    const missing = run({
      describe: 'echo "ERROR: NOT_FOUND: Secret [MY_SECRET] not found." >&2; exit 1',
      access: "exit 1",
      valueArg,
    });
    assert.doesNotMatch(missing.calls, /secrets create/, `${JSON.stringify(valueArg)} must not create an empty secret`);
  }
});

// The deploy sends the value on stdin (VALUE "-"). This runner is the same gcloud shim
// as run(), except that `versions add` and `secrets create` keep the bytes they were
// given, and every gcloud call records ps's view of the process that made it.
const PS_AVAILABLE = spawnSync("ps", ["-p", String(process.pid)]).status === 0;

function runWithStdin({ describe, access, stdin, bashEnv }) {
  const dir = mkdtempSync(join(tmpdir(), "ensure-secret-stdin-"));
  const calls = join(dir, "calls.log");
  const psLog = join(dir, "ps.log");
  const written = join(dir, "written");
  const shim = `#!/usr/bin/env bash
echo "$*" >> "${calls}"
ps -o args= -p $PPID >> "${psLog}" 2>/dev/null
case "$1 $2" in
  "secrets describe") ${describe} ;;
  "secrets versions")
    case "$3" in
      add) cat > "${written}" ;;
      *) ${access} ;;
    esac
    ;;
  "secrets create") cat > "${written}" ;;
  *) exit 0 ;;
esac
`;
  writeFileSync(join(dir, "gcloud"), shim);
  chmodSync(join(dir, "gcloud"), 0o755);
  try {
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GCP_PROJECT_ID: "test-project" };
    if (bashEnv) env.BASH_ENV = bashEnv;
    const result = spawnSync("bash", [script, "MY_SECRET", "-"], { input: stdin, env, encoding: "utf8" });
    const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      calls: read(calls),
      ps: read(psLog),
      written: existsSync(written) ? read(written) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("VALUE - versions the value read from stdin, and drops only its trailing CR/LF", () => {
  const result = runWithStdin({ describe: "exit 0", access: 'printf "%s" "old-value"; exit 0', stdin: "new-value\r\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /secrets versions add MY_SECRET/);
  assert.equal(result.written, "new-value", "the stored bytes are the value without its trailing CR/LF");
});

test("VALUE - with nothing on stdin, or only CR/LF, is not set: never versioned, never created", () => {
  for (const stdin of ["", "\n", "\r\n"]) {
    const existing = runWithStdin({ describe: "exit 0", access: 'printf "%s" "old-value"; exit 0', stdin });
    assert.equal(existing.status, 0, `${JSON.stringify(stdin)}: ${existing.stderr}`);
    assert.match(existing.stdout, /not set, skipping/, JSON.stringify(stdin));
    assert.doesNotMatch(existing.calls, /versions add/, JSON.stringify(stdin));

    const missing = runWithStdin({
      describe: 'echo "ERROR: NOT_FOUND: Secret [MY_SECRET] not found." >&2; exit 1',
      access: "exit 1",
      stdin,
    });
    assert.doesNotMatch(missing.calls, /secrets create/, JSON.stringify(stdin));
  }
});

// A process argument list is visible to ps for as long as the process lives, and this
// script makes three gcloud calls. The control proves ps showed the script's own
// argument list, so the absence of the value below means something.
test("a value read from stdin is never in the argument list of the script or of any gcloud call", { skip: !PS_AVAILABLE }, () => {
  const value = "FAKE-stdin-value-0001-not-real";
  const result = runWithStdin({ describe: "exit 0", access: 'printf "%s" "old-value"; exit 0', stdin: value });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /versions add/);
  assert.equal(result.written, value, "the value on stdin must be the one that was stored, or the check below proves nothing");
  assert.match(result.ps, /ensure-secret\.sh MY_SECRET -/, `control: ps must show the script's argument list:\n${result.ps}`);
  assert.ok(!result.ps.includes(value), `the value was in an argument list:\n${result.ps}`);
});

// bash -x, SHELLOPTS and a BASH_ENV that sets -x trace every command the script runs.
// The control shows this bash does print an assignment under -x, so the clean run means something.
test("a BASH_ENV that sets -x does not trace a value read from stdin", () => {
  const dir = mkdtempSync(join(tmpdir(), "ensure-secret-xtrace-"));
  try {
    const bashEnv = join(dir, "bash-env.sh");
    writeFileSync(bashEnv, "set -x\n");
    const value = "FAKE-xtrace-value-0001-not-real";
    const probe = spawnSync("bash", ["-x", "-c", 'V="$1"', "probe", value], { encoding: "utf8" });
    assert.ok(probe.stderr.includes(value), "control failed: bash -x did not trace the assignment");

    const result = runWithStdin({ describe: "exit 0", access: 'printf "%s" "old-value"; exit 0', stdin: value, bashEnv });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /versions add/);
    assert.equal(result.written, value, "the value on stdin must be the one that was stored, or the check below proves nothing");
    assert.ok(!result.stderr.includes(value), "the xtrace on stderr leaked the value");
    assert.ok(!result.stdout.includes(value), "stdout leaked the value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
