import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainTf = readFileSync(new URL("./main.tf", import.meta.url), "utf8");
const variablesTf = readFileSync(new URL("./variables.tf", import.meta.url), "utf8");

test("chat service receives the internal service secret", () => {
  assert.match(variablesTf, /variable "internal_service_secret_name"/);
  assert.match(variablesTf, /default\s+=\s+"INTERNAL_SERVICE_SECRET"/);
  assert.match(mainTf, /resource "google_secret_manager_secret_iam_member" "internal_service_secret"/);
  assert.match(mainTf, /secret_id\s+=\s+var\.internal_service_secret_name/);
  assert.match(mainTf, /name\s+=\s+"INTERNAL_SERVICE_SECRET"[\s\S]*?secret\s+=\s+var\.internal_service_secret_name/);
  assert.match(mainTf, /google_secret_manager_secret_iam_member\.internal_service_secret/);
});

const deployWorkflow = readFileSync(new URL("../../../.github/workflows/terraform-deploy.yml", import.meta.url), "utf8");

test("optional chat secrets are granted, waited for, then used by the revision", () => {
  assert.match(mainTf, /resource "time_sleep" "optional_secret_grants"[\s\S]*?create_duration\s+=\s+"30s"/);
  assert.match(mainTf, /google_secret_manager_secret_iam_member\.optional_secrets/);
  assert.match(mainTf, /depends_on = \[[\s\S]*?time_sleep\.optional_secret_grants[\s\S]*?\]/);
});

test("the deploy resolves optional chat secrets by content, before both Terraform steps", () => {
  const resolve = [...deployWorkflow.matchAll(/- name: Resolve optional chat secrets/g)].map((m) => m.index);
  const plan = deployWorkflow.indexOf("- name: Terraform Plan");
  const apply = deployWorkflow.indexOf("- name: Terraform Apply");
  assert.equal(resolve.length, 2, "one Resolve step before the plan and one before the apply");
  assert.ok(resolve[0] < plan, "the plan's Resolve step runs before Terraform Plan");
  assert.ok(resolve[1] < apply, "the apply's Resolve step runs before Terraform Apply");
  const resolveBlocks = [...deployWorkflow.matchAll(/- name: Resolve optional chat secrets[\s\S]*?(?=\n {6}- name: )/g)].map((m) => m[0]);
  assert.equal(resolveBlocks.length, 2);
  for (const block of resolveBlocks) {
    assert.match(block, /tr -d '\\r\\n\[:space:\]'/, "each Resolve step judges content with CR, LF and whitespace removed");
  }
});

test("the validate-secrets job does not require the optional chat secrets", () => {
  const job = deployWorkflow.slice(deployWorkflow.indexOf("\n  validate-secrets:"), deployWorkflow.indexOf("\n  build-images:"));
  assert.ok(job.length > 0);
  assert.doesNotMatch(job, /FLAGGR|DEEPSEEK|OPENROUTER/);
});

test("the OpenRouter chat key is an optional, dedicated secret with its own cap", () => {
  // The config reads OPENROUTER_API_KEY_CHAT; the Secret Manager secret has the same name.
  assert.match(mainTf, /optional_secret_names = compact\(\[[\s\S]*?var\.openrouter_api_key_secret_name[\s\S]*?\]\)/);
  assert.match(mainTf, /name = "OPENROUTER_API_KEY_CHAT"[\s\S]*?secret\s+=\s+env\.value/);
  assert.match(variablesTf, /variable "openrouter_api_key_secret_name"[\s\S]*?default\s+=\s+""/);
  assert.doesNotMatch(mainTf, /OPENROUTER_API_KEY"/, "chat must not read the report extractor's OPENROUTER_API_KEY");
});

test("the production chat module states CHAT_ALLOW_PRC_HOSTED_PROVIDER on every revision", () => {
  assert.match(mainTf, /name\s+=\s+"CHAT_ALLOW_PRC_HOSTED_PROVIDER"\s+value = var\.allow_prc_hosted_provider \? "true" : "false"/);
});

test("the deploy resolves OPENROUTER_API_KEY_CHAT by content and syncs it like DEEPSEEK_API_KEY", () => {
  const resolveBlocks = [...deployWorkflow.matchAll(/- name: Resolve optional chat secrets[\s\S]*?(?=\n {6}- name: )/g)].map((m) => m[0]);
  assert.equal(resolveBlocks.length, 2);
  for (const block of resolveBlocks) {
    assert.match(block, /TF_VAR_openrouter_api_key_secret_name=OPENROUTER_API_KEY_CHAT/);
    assert.match(block, /has_content "\$OPENROUTER_API_KEY_CHAT"/);
  }
  // Both Ensure steps sync it under the same name, gated by content.
  const ensureLine = 'if has_content "$OPENROUTER_API_KEY_CHAT"; then ensure_secret "OPENROUTER_API_KEY_CHAT" "$OPENROUTER_API_KEY_CHAT"; fi';
  assert.equal(deployWorkflow.split(ensureLine).length - 1, 2, "plan and apply Ensure steps each sync it");
  // The report extractor's key is never written or referenced by the deploy.
  assert.doesNotMatch(deployWorkflow, /ensure_secret "OPENROUTER_API_KEY"/);
  assert.doesNotMatch(deployWorkflow, /secrets\.OPENROUTER_API_KEY\b/);
});

