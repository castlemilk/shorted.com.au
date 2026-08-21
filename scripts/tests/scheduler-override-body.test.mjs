// node --test scripts/tests/scheduler-override-body.test.mjs
//
// Cloud Scheduler jobs that trigger a Cloud Run Job with a `:run` overrides
// body have exactly one way to tell you they are malformed: status code 3,
// INVALID_ARGUMENT, with no field name anywhere in the scheduler logs. The
// schedule simply never fires and nothing downstream notices.
//
// That happened to house-price-collector-drop-index (#436): the body carried
// the Cloud Run **v2** spelling of the task deadline, `timeout: "14400s"`,
// while the target uri was the **v1** namespaces endpoint, whose `Overrides`
// message spells it `timeoutSeconds` as an integer. Every attempt 400'd with
//   Unknown name "timeout" at 'overrides': Cannot find field.
// so the daily discounting index never ran once between the deploy and the
// fix.
//
// This guard pins the two spellings to their API surfaces so the next override
// body cannot repeat it.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const modulesDir = join(repoRoot, "terraform/modules");

function tfFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tfFiles(full));
    else if (entry.endsWith(".tf")) out.push(full);
  }
  return out;
}

// Extract the `{ ... }` object literal passed to each `jsonencode(` in source,
// by brace matching from the call site.
function jsonencodeBlocks(source) {
  const blocks = [];
  let idx = source.indexOf("jsonencode(");
  while (idx !== -1) {
    let depth = 0;
    let start = -1;
    for (let i = idx; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          blocks.push(source.slice(start, i + 1));
          break;
        }
      }
    }
    idx = source.indexOf("jsonencode(", idx + 1);
  }
  return blocks;
}

const overrideBodies = [];
for (const file of tfFiles(modulesDir)) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("google_cloud_scheduler_job")) continue;
  const usesV1 = source.includes("/apis/run.googleapis.com/v1/namespaces");
  for (const block of jsonencodeBlocks(source)) {
    if (!/\boverrides\s*=/.test(block)) continue;
    overrideBodies.push({ file, block, usesV1 });
  }
}

test("terraform ships at least one Cloud Run :run overrides body", () => {
  assert.ok(
    overrideBodies.length > 0,
    "expected to find scheduler overrides bodies — did the extractor break?",
  );
});

test("v1 :run overrides bodies use timeoutSeconds, never the v2 timeout", () => {
  for (const { file, block, usesV1 } of overrideBodies) {
    if (!usesV1) continue;
    const rel = file.slice(repoRoot.length + 1);
    assert.ok(
      !/^\s*timeout\s*=/m.test(block),
      `${rel}: an overrides body for the v1 namespaces :run endpoint sets ` +
        `\`timeout\`, which does not exist on v1 Overrides. Every invocation ` +
        `will 400 / INVALID_ARGUMENT. Use \`timeoutSeconds = <int>\` instead.`,
    );
  }
});

test("timeoutSeconds is an integer, not a duration string", () => {
  for (const { file, block } of overrideBodies) {
    const match = block.match(/^\s*timeoutSeconds\s*=\s*(\S+)/m);
    if (!match) continue;
    const rel = file.slice(repoRoot.length + 1);
    assert.match(
      match[1],
      /^\d+$/,
      `${rel}: timeoutSeconds must be a bare integer number of seconds ` +
        `(got ${match[1]}); a "900s"-style duration string is the v2 spelling.`,
    );
  }
});
