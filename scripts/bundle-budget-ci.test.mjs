import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), "shorted-bundle-ci-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("capturing the production build preserves its failure and stderr", (t) => {
  const directory = scratch(t);
  const workflow = readFileSync(new URL("../.github/workflows/perf-budget.yml", import.meta.url), "utf8");
  const block = workflow.match(/- name: Production build\n        run: \|\n((?:          [^\n]*\n)+)/);
  assert.ok(block, "production build should capture its output");
  const command = block[1].replace(/^          /gm, "");
  writeFileSync(join(directory, "npx"), "#!/bin/sh\nprintf 'build stdout\\n'\nprintf 'build stderr\\n' >&2\nexit 7\n", { mode: 0o755 });
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", command], {
    cwd: directory,
    env: { ...process.env, PATH: directory + delimiter + process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 7, "tee must not hide a failed production build");
  assert.equal(readFileSync(join(directory, "perf-results/build.log"), "utf8"), "build stdout\nbuild stderr\n");
});

test("existing build output passes budgets without invoking another build", (t) => {
  const directory = scratch(t);
  writeFileSync(join(directory, "build.log"), "┌ ○ / 12 kB 170 kB\n+ First Load JS shared by all 96.1 kB\n");
  writeFileSync(join(directory, "baseline.json"), JSON.stringify({ sharedByAllKB: 96.1, routes: { "/": { firstLoadKB: 170 } } }));
  const result = runBudget(directory);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /all bundle budgets met/);
  assert.match(result.stdout, /no regressions/);
  assert.equal(JSON.parse(readFileSync(join(directory, "report.json"), "utf8")).routes["/"].firstLoadKB, 170);
});

test("existing build output still rejects route-budget and baseline regressions", (t) => {
  const directory = scratch(t);
  writeFileSync(join(directory, "baseline.json"), JSON.stringify({ sharedByAllKB: 96.1, routes: { "/": { firstLoadKB: 170 } } }));
  for (const [size, failure] of [[195, /bundle budget breach/], [181, /1 regression\(s\)/]]) {
    writeFileSync(join(directory, "build.log"), `┌ ○ / 12 kB ${size} kB\n+ First Load JS shared by all 96.1 kB\n`);
    const result = runBudget(directory);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, failure);
  }
});

function runBudget(directory) {
  const script = fileURLToPath(new URL("../web/scripts/bundle-budget.mjs", import.meta.url));
  // An empty PATH ensures the captured-log path cannot invoke npx/next.
  return spawnSync(process.execPath, [script, "--build-log", "build.log", "--compare", "baseline.json", "--out", "report.json"], {
    cwd: directory,
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
  });
}
