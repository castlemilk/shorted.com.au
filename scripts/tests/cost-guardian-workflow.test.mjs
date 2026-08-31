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
