import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// Execute the real make recipes with a fake Go CLI. No Docker, network,
// application process or database is touched by these contract tests.
function runMake(t, failAt = "", image = "") {
  const dir = mkdtempSync(join(tmpdir(), "integration-prefetch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls");
  const go = join(dir, "go");
  writeFileSync(go, `#!/bin/sh
printf '%s|%s|%s\\n' "$PWD" "$GOWORK" "$*" >> "$CALL_LOG"
case "$1" in
  run) [ "$FAIL_AT" = prefetch ] && exit 17 ;;
  test)
    case "$PWD" in
      */test/integration) [ "$FAIL_AT" = api ] && exit 23 ;;
      */services/market-data) [ "$FAIL_AT" = market ] && exit 29 ;;
    esac ;;
esac
exit 0
`);
  chmodSync(go, 0o755);
  const result = spawnSync("make", ["--no-print-directory", "-C", join(repoRoot, "services"), "test-integration-ci"], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log, FAIL_AT: failAt, MARKET_DATA_TEST_POSTGRES_IMAGE: image },
  });
  return { result, calls: readFileSync(log, "utf8").trim().split("\n") };
}

test("prefetch precedes both suites and includes each module's Ryuk", (t) => {
  const { result, calls } = runMake(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /\|off\|run .*prefetch-integration-images\/main.go postgres:15-alpine postgres:15-alpine testcontainers\/ryuk:0.13.0 testcontainers\/ryuk:0.8.1$/);
  assert.match(calls[1], /\/test\/integration\|.*\|test /);
  assert.match(calls[2], /\/services\/market-data\|.*\|test /);
});

test("prefetch uses the market-data PostgreSQL override", (t) => {
  const { result, calls } = runMake(t, "", "postgres:16-alpine");
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls[0], /postgres:15-alpine postgres:16-alpine/);
});

for (const [failure, count] of [["prefetch", 1], ["api", 2], ["market", 3]]) {
  test(`${failure} failure stops make without repeating tests`, (t) => {
    const { result, calls } = runMake(t, failure);
    assert.notEqual(result.status, 0);
    assert.equal(calls.length, count);
  });
}

test("dependency upgrades require reviewing the prefetched image pins", () => {
  for (const [path, version] of [["test/integration/go.mod", "v0.39.0"], ["services/go.mod", "v0.33.0"]]) {
    const dependency = readFileSync(join(repoRoot, path), "utf8").match(/github.com\/testcontainers\/testcontainers-go (v[\d.]+)/)?.[1];
    assert.equal(dependency, version, `review Ryuk image for ${path}`);
  }
  for (const path of ["test/integration/setup_test.go", "services/market-data/setup_test.go"]) {
    const source = readFileSync(join(repoRoot, path), "utf8");
    assert.match(source, /"postgres:15-alpine"/, `review default PostgreSQL image for ${path}`);
  }
});

test("hygiene checkout supplies the integration contract inputs", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/repo-hygiene.yml"), "utf8");
  const job = workflow.split("\n  portal-content-provenance:\n")[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
  assert.ok(job, "repository hygiene job is missing");
  const paths = [...job.matchAll(/^ {12}(\S+)$/gm)].map((match) => match[1]);
  for (const file of ["services/Makefile", "services/go.mod", "services/market-data/setup_test.go", "test/integration/go.mod", "test/integration/setup_test.go"]) {
    assert.ok(paths.some((path) => file === path || file.startsWith(`${path}/`)),
      `hygiene sparse checkout omits ${file}`);
  }
});
