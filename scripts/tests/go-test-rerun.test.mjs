import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import YAML from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const step = (workflow, job, name) => {
  const j = YAML.parse(read(workflow)).jobs[job];
  assert.ok(j, `${workflow}: job ${job} missing`);
  const s = j.steps.find((x) => x.name === name);
  assert.ok(s, `${workflow}: step "${name}" missing in ${job}`);
  return s;
};

// Four deploy-gating runs over 2026-11-05 and 06 failed on four different collector
// tests, each green locally and on the runs before and after. A package that fails is
// run once more on its own; a flake passes with a warning naming its tests, and a
// regression fails twice.
test("the Go unit-test steps run through the rerun wrapper", () => {
  const services = step(".github/workflows/go-quality.yml", "unit-tests", "services module");
  assert.equal(services["working-directory"], "services");
  assert.match(services.run, /^\.\.\/scripts\/ci\/go-test-rerun\.sh \.\/\.\.\. -short$/);
  const jobs = step(".github/workflows/go-quality.yml", "unit-tests", "services/jobs module");
  assert.equal(jobs["working-directory"], "services/jobs");
  assert.match(jobs.run, /^\.\.\/\.\.\/scripts\/ci\/go-test-rerun\.sh \.\/\.\.\. -short$/);
  const gate = step(".github/workflows/terraform-deploy.yml", "run-tests", "Run services unit tests (gates the deploy)");
  assert.equal(gate["working-directory"], "services");
  assert.match(gate.run, /^\.\.\/scripts\/ci\/go-test-rerun\.sh \.\/\.\.\. -short$/);
});

test("the wrapper reruns only the failed packages, without the test cache, and fails on a second failure", () => {
  const sh = read("scripts/ci/go-test-rerun.sh");
  assert.match(sh, /grep -E '\^FAIL\[\[:space:\]\]\+\[\^\[:space:\]\]\+' "\$out"/, "the failed packages come from go test's FAIL lines");
  assert.match(sh, /go test -count=1 "\$\{rerun\[@\]\}" \$failed/, "the rerun is -count=1 over the failed packages only");
  assert.match(sh, /::warning::go test: the rerun passed/);
  assert.match(sh, /::error::go test: failed on both runs/);
  assert.match(sh, /^exit 1$/m);
});

test("the bake push and the terraform apply each retry a transient failure", () => {
  const bake = step(".github/workflows/terraform-deploy.yml", "build-images", "Build and push all images");
  assert.match(bake.run, /for attempt in 1 2 3; do/);
  assert.match(bake.run, /docker buildx bake --file docker-bake\.hcl --builder shorted-builder --push --progress plain/);
  const apply = step(".github/workflows/terraform-deploy.yml", "terraform-apply", "Terraform Apply");
  assert.match(apply.run, /apply\(\) \{/);
  assert.match(apply.run, /if apply; then exit 0; fi/);
  assert.equal(apply.run.split("\n").filter((l) => l.trim() === "apply").length, 1, "one retry, not a loop");
});
