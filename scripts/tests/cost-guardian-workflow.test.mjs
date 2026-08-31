import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflowSource = readFileSync(
  new URL("../../.github/workflows/cost-guardian.yml", import.meta.url),
  "utf8",
);

function jobBlock(jobName, nextJobName) {
  const start = workflowSource.indexOf(`  ${jobName}:`);
  assert.notEqual(start, -1, `missing workflow job ${jobName}`);
  const end = nextJobName
    ? workflowSource.indexOf(`  ${nextJobName}:`, start)
    : workflowSource.length;
  assert.notEqual(end, -1, `missing next workflow job ${nextJobName}`);
  return workflowSource.slice(start, end);
}

test("manual secret cleanup can exclude unrelated production mutations", () => {
  assert.match(
    workflowSource,
    /secrets_only:\s+description:[\s\S]*?type: boolean\s+default: false/,
  );

  for (const [jobName, nextJobName] of [
    ["enforce-scaling", "cleanup-artifact-registry"],
    ["cleanup-artifact-registry", "cleanup-secret-versions"],
  ]) {
    const condition = jobBlock(jobName, nextJobName).replace(/\s+/g, " ");
    assert.match(condition, /github\.event_name == 'schedule'/, jobName);
    assert.match(condition, /inputs\.secrets_only != true/, jobName);
  }

  const secretJob = jobBlock("cleanup-secret-versions");
  assert.doesNotMatch(
    secretJob.slice(0, secretJob.indexOf("    steps:")),
    /secrets_only/,
    "secrets-only dispatch must not skip the secret cleanup job",
  );
});

test("manual destruction can be bounded to one exact secret version range", () => {
  for (const input of [
    "secret_name",
    "destroy_min_version",
    "destroy_max_version",
    "skip_disable",
  ]) {
    assert.match(workflowSource, new RegExp(`\\n      ${input}:`), input);
  }

  const secretJob = jobBlock("cleanup-secret-versions");
  assert.match(secretJob, /SECRET_NAME:.*inputs\.secret_name/);
  assert.match(secretJob, /DESTROY_MIN_VERSION:.*inputs\.destroy_min_version/);
  assert.match(secretJob, /DESTROY_MAX_VERSION:.*inputs\.destroy_max_version/);
  assert.match(secretJob, /SKIP_DISABLE:.*inputs\.skip_disable/);
  assert.match(secretJob, /ARGS\+=\(--only-secret "\$SECRET_NAME"\)/);
  assert.match(secretJob, /ARGS\+=\(--destroy-min-version "\$DESTROY_MIN_VERSION"\)/);
  assert.match(secretJob, /ARGS\+=\(--destroy-max-version "\$DESTROY_MAX_VERSION"\)/);
  assert.match(secretJob, /ARGS\+=\(--skip-disable\)/);
});
