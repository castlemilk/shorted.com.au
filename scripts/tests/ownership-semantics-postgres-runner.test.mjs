import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));

// Exercise the actual runner process with synthetic Docker/Go CLIs. These
// tests prove fail-closed orchestration and cleanup, not database semantics;
// the dedicated PR job then runs the same script with real PostgreSQL.
function run(t, mode = "pass") {
  const dir = mkdtempSync(join(tmpdir(), "ownership-pg-runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dockerLog = join(dir, "docker.log");
  const goLog = join(dir, "go.log");
  const docker = join(dir, "docker");
  const go = join(dir, "go");
  writeFileSync(docker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_CALL_LOG"
case "$1" in
  info) [[ "$RUNNER_TEST_MODE" == no_daemon ]] && exit 19 ;;
  run) [[ "$RUNNER_TEST_MODE" == start_failure ]] && exit 21; echo synthetic-container ;;
  port) echo 127.0.0.1:55432 ;;
  rm) [[ "$RUNNER_TEST_MODE" == cleanup_failure ]] && exit 22 ;;
esac
exit 0
`);
  writeFileSync(go, `#!/usr/bin/env bash
if [[ "$1" == version ]]; then echo 'go version go1.27.0 linux/amd64'; exit 0; fi
printf '%s\\n' "$PWD" "$*" "$GOWORK" "$GOPROXY" "$GOVCS" "$OWNERSHIP_SEMANTICS_REQUIRE_DATABASE" "$OWNERSHIP_SEMANTICS_TEST_DATABASE_URL" >> "$GO_CALL_LOG"
[[ "$RUNNER_TEST_MODE" == go_failure ]] && exit 23
if [[ "$RUNNER_TEST_MODE" == skipped ]]; then
  echo '{"Action":"skip","Test":"TestPostgresSemanticRevisions"}'
elif [[ "$RUNNER_TEST_MODE" == skipped_subtest ]]; then
  echo '{"Action":"skip","Test":"TestPostgresSemanticRevisions/replay"}'
  echo '{"Action":"pass","Test":"TestPostgresSemanticRevisions"}'
elif [[ "$RUNNER_TEST_MODE" != no_test ]]; then
  echo '{"Action":"pass","Test":"TestPostgresSemanticRevisions"}'
fi
echo '{"Action":"pass","Package":"ownershipsemantics"}'
`);
  chmodSync(docker, 0o755);
  chmodSync(go, 0o755);
  writeFileSync(dockerLog, "");
  writeFileSync(goLog, "");
  const result = spawnSync("bash", [join(root, "scripts/test-ownership-semantics-postgres.sh")], {
    encoding: "utf8", timeout: 15_000, cwd: root,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      OWNERSHIP_SEMANTICS_GO_BIN: go,
      DOCKER_CALL_LOG: dockerLog,
      GO_CALL_LOG: goLog,
      RUNNER_TEST_MODE: mode,
      GITHUB_OUTPUT: join(dir, "github-output"),
      // An inherited DSN must never redirect this test runner.
      OWNERSHIP_SEMANTICS_TEST_DATABASE_URL: "postgres://unused.invalid/never_connect",
    },
  });
  assert.ifError(result.error);
  let output = "";
  try { output = readFileSync(join(dir, "github-output"), "utf8"); } catch { /* preflight failure */ }
  return { result, docker: readFileSync(dockerLog, "utf8"), go: readFileSync(goLog, "utf8"), output };
}

test("runs the required DB test with a generated loopback DSN and removes its own container", (t) => {
  const { result, docker, go, output } = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(go, /\/services\ntest -json -count=1 -timeout=180s -run \^TestPostgresSemanticRevisions\$ \.\/pkg\/ownershipsemantics\noff\nhttps:\/\/proxy\.golang\.org\n\*:off\n1\n/);
  assert.match(go, /@127\.0\.0\.1:55432\/shorted_ownership_semantics_test\?/);
  assert.doesNotMatch(go, /unused\.invalid/);
  const name = docker.match(/run .*--name (\S+)/)?.[1];
  assert.ok(name);
  assert.ok(docker.includes(`rm --force --volumes ${name}`));
  assert.equal(output, `container_name=${name}\n`);
});

for (const mode of ["skipped", "skipped_subtest", "no_test"]) {
  test(`${mode} cannot masquerade as real database verification`, (t) => {
    const { result, docker } = run(t, mode);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /skipped|verification did not run/);
    assert.match(docker, /rm --force --volumes shorted-ownership-semantics-/);
  });
}

test("Go failure keeps its exit status and cleans up the database", (t) => {
  const { result, docker } = run(t, "go_failure");
  assert.equal(result.status, 23);
  assert.match(docker, /rm --force --volumes shorted-ownership-semantics-/);
});

test("a failed container start still attempts cleanup", (t) => {
  const { result, docker, go } = run(t, "start_failure");
  assert.equal(result.status, 21);
  assert.equal(go, "");
  assert.match(docker, /rm --force --volumes shorted-ownership-semantics-/);
});

test("missing Docker daemon fails before test execution", (t) => {
  const { result, docker, go } = run(t, "no_daemon");
  assert.equal(result.status, 19);
  assert.equal(go, "");
  assert.doesNotMatch(docker, /run |rm /);
});

test("cleanup failure fails an otherwise successful run", (t) => {
  const { result } = run(t, "cleanup_failure");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not remove/);
});
