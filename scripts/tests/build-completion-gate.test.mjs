import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url), "utf8");
const sha = "7b1f024cf19f6074078fc5f72eb714d789221bb8";
const consumers = ["mirror-images", "terraform-plan", "run-tests", "terraform-apply", "bump-vke-jobs-image", "deploy-vercel-prod"];

function job(name) {
  const block = source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "m"));
  assert.ok(block, `missing job ${name}`);
  return block[1];
}

function condition(name) {
  const block = job(name);
  const inline = block.match(/^    if: (.*)$/m)?.[1];
  assert.ok(inline, `missing condition on ${name}`);
  if (!/^[|>]-?$/.test(inline)) return inline;
  return block.match(/^    if: [|>]-?\n((?:      .*\n)+)/m)[1].trim();
}

function allowed(name, result, builtSha, event = "push") {
  const needs = Object.fromEntries(["determine-environment", "validate-secrets", "build-images", "terraform-plan", "run-tests", "terraform-apply"].map((name) => [name, { result: "success", outputs: {} }]));
  needs["determine-environment"].outputs.environment = "prod";
  needs["build-images"] = { result, outputs: { "built-sha": builtSha } };
  // Only evaluate our repository's declarative job condition against fixtures.
  const expression = condition(name).replace(/\.([a-z][a-z0-9]*-[a-z0-9-]+)/g, '["$1"]');
  return Boolean(runInNewContext(expression, {
    needs,
    github: { sha, ref: "refs/heads/main", event_name: event, event: { inputs: { plan_only: "false" } } },
    always: () => true,
  }, { timeout: 1000 }));
}

test("all image consumers require this commit's explicit completed bake, not a green label alone", () => {
  for (const name of consumers) {
    assert.match(job(name), /^    needs: .*\bbuild-images\b/m, `${name} needs direct build evidence`);
    for (const marker of [undefined, "", "other-commit"]) {
      assert.equal(allowed(name, "success", marker), false, `${name} admitted missing/stale completion ${marker}`);
    }
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.equal(allowed(name, result, sha), false, `${name} admitted ${result}`);
    }
    assert.equal(allowed(name, "success", sha), true, `${name} rejected an explicitly completed bake`);
  }
});

test("PR planning can skip images without opening production paths", () => {
  assert.equal(allowed("terraform-plan", "skipped", undefined, "pull_request"), true);
  for (const name of consumers.filter((name) => name !== "terraform-plan")) {
    assert.equal(allowed(name, "skipped", undefined, "pull_request"), false, name);
    assert.equal(allowed(name, "success", sha, "pull_request"), false, name);
  }
});

test("completion is emitted only after bake exits successfully and is exported as a job output", () => {
  const build = job("build-images");
  assert.match(build, /built-sha: \$\{\{ steps\.bake\.outputs\.built-sha \}\}/);
  const bake = build.slice(build.indexOf("      - name: Build and push all images"));
  assert.match(bake, /^        id: bake$/m);
  const script = bake.match(/^        run: \|\n((?:          .*\n|\n)+)/m)?.[1].replace(/^          /gm, "");
  assert.ok(script, "missing bake script");
  const directory = mkdtempSync(join(tmpdir(), "shorted-bake-completion-"));
  try {
    for (const exitCode of [0, 1, 137]) {
      const output = join(directory, `outputs-${exitCode}`);
      const result = spawnSync("bash", ["-c", `docker() { return ${exitCode}; }\n${script}`], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, GITHUB_SHA: sha, GITHUB_OUTPUT: output },
      });
      assert.equal(result.status, exitCode, result.stdout + result.stderr);
      if (exitCode === 0) assert.equal(readFileSync(output, "utf8"), `built-sha=${sha}\n`);
      else assert.throws(() => readFileSync(output), { code: "ENOENT" });
    }
    for (const marker of [undefined, ""]) {
      const output = join(directory, `missing-sha-${String(marker)}`);
      const env = { PATH: process.env.PATH, GITHUB_OUTPUT: output };
      if (marker !== undefined) env.GITHUB_SHA = marker;
      const result = spawnSync("bash", ["-c", `docker() { return 0; }\n${script}`], { encoding: "utf8", env });
      assert.notEqual(result.status, 0, "missing commit must fail closed");
      assert.throws(() => readFileSync(output), { code: "ENOENT" });
    }
    const noOutput = spawnSync("bash", ["-c", `docker() { return 0; }\n${script}`], {
      encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_SHA: sha },
    });
    assert.notEqual(noOutput.status, 0, "missing output channel must fail closed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
