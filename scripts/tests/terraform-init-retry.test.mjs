import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "scripts/ci/terraform-init-retry.sh");

// A fake terraform that fails the first `failures` calls with `message` and then
// succeeds, counting its calls in a file.
function run({ failures, message, attempts = 5 }) {
  const dir = mkdtempSync(join(tmpdir(), "tf-init-retry-"));
  try {
    const count = join(dir, "count");
    writeFileSync(count, "0");
    const fake = join(dir, "terraform");
    writeFileSync(
      fake,
      [
        "#!/usr/bin/env bash",
        `n=$(( $(cat "${count}") + 1 )); echo "$n" > "${count}"`,
        `echo "args: $*"`,
        `if [ "$n" -le ${failures} ]; then printf '%s\\n' ${JSON.stringify(message)} >&2; exit 1; fi`,
        `echo "Terraform has been successfully initialized!"`,
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    const res = spawnSync("bash", [script, "-upgrade=false"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TF_INIT_RETRY_DELAY: "0", TF_INIT_ATTEMPTS: String(attempts) },
    });
    return { status: res.status, out: res.stdout + res.stderr, calls: Number(readFileSync(count, "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GITHUB_504 = "Error while installing cloudflare/cloudflare v5.26.0: github.com: bad response code: 504";

test("a provider download that 504s is retried until it succeeds, with a warning", () => {
  const r = run({ failures: 2, message: GITHUB_504 });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.calls, 3);
  assert.match(r.out, /::warning::terraform init: attempt 1 of 5 failed \(bad response code: 504\)/);
  assert.match(r.out, /::warning::terraform init: succeeded on attempt 3 of 5/);
  assert.match(r.out, /args: init -input=false -upgrade=false/, "the caller's arguments pass through");
});

test("a download that keeps failing fails the step after the last attempt", () => {
  const r = run({ failures: 99, message: GITHUB_504, attempts: 3 });
  assert.equal(r.status, 1);
  assert.equal(r.calls, 3);
  assert.match(r.out, /::error::terraform init: still failing after 3 attempts/);
});

test("a non-network failure fails at once, without a retry", () => {
  const r = run({ failures: 99, message: 'Error: Failed to get existing workspaces: querying Cloud Storage failed: storage: bucket doesn\'t exist' });
  assert.equal(r.status, 1);
  assert.equal(r.calls, 1);
  assert.doesNotMatch(r.out, /::warning::/);
});

test("a clean init runs once and prints no warning", () => {
  const r = run({ failures: 0, message: "" });
  assert.equal(r.status, 0);
  assert.equal(r.calls, 1);
  assert.doesNotMatch(r.out, /::warning::/);
});

test("both deploy jobs initialise through the retry wrapper", () => {
  const jobs = YAML.parse(readFileSync(join(root, ".github/workflows/terraform-deploy.yml"), "utf8")).jobs;
  for (const job of ["terraform-plan", "terraform-apply"]) {
    const step = jobs[job].steps.find((s) => s.name === "Terraform Init");
    assert.ok(step, `${job}: no Terraform Init step`);
    assert.match(step.run.trim(), /^\.\.\/\.\.\/\.\.\/scripts\/ci\/terraform-init-retry\.sh$/, `${job} calls terraform init directly`);
  }
});
