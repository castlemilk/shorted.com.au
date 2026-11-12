import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { postPromotePaths } from "../post-promote-isr-paths.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
const pages = readJson("web/src/config/isr-pages.json");
const shells = readJson("web/src/config/isr-shell-pages.json");
const states = ["act", "nsw", "nt", "qld", "sa", "tas", "vic", "wa"];

test("release sweep refreshes state indexes without naming housing profiles or their parents", () => {
  const paths = postPromotePaths(pages, shells);
  assert.equal(paths.filter((path) => path === "/housing/[state]").length, 1);
  for (const path of [
    "/housing",
    ...states.map((state) => `/housing/${state}`),
    ...states.map((state) => `/housing/${state}/council`),
    "/housing/[state]/[suburb]",
    "/housing/[state]/council/[slug]",
  ]) assert.ok(!paths.includes(path), `${path} would reach housing profiles or duplicate the shell warmer`);

  for (const path of ["/top", "/housing/calculators", "/housing/rankings", "/housing/capitals", "/economy/[state]/[topic]"]) {
    assert.ok(paths.includes(path), `${path} must keep its release refresh`);
  }
  for (const path of shells) assert.ok(!paths.includes(path), `${path} belongs to the shell warmer`);
});

test("release selection fails closed on malformed inventories and unscoped housing descendants", () => {
  assert.throws(() => postPromotePaths([], []), /non-empty array/);
  assert.throws(() => postPromotePaths(["/top"], ["invalid"]), /shell pages/);
  assert.throws(() => postPromotePaths(["/housing"], []), /shell warmer/);
  for (const path of ["/housing/nsw/bondi", "/housing/[state]/[slug]", "/housing/nsw/council"]) {
    assert.throws(() => postPromotePaths([path], []), /explicit release scope/);
  }
});

test("production workflow uses the selector and aborts the sweep if it fails", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url), "utf8");
  const start = workflow.indexOf("      - name: Revalidate ISR pages post-promote");
  const end = workflow.indexOf("\n      - name:", start + 1);
  assert.ok(start >= 0 && end > start);
  const step = workflow.slice(start, end);
  assert.match(step, /set -euo pipefail/);
  assert.match(step, /isr_paths=\$\(node scripts\/post-promote-isr-paths\.mjs\)/);
  assert.match(step, /--data-urlencode "path=\$isr_paths"/);

  const result = spawnSync(process.execPath, ["scripts/post-promote-isr-paths.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split(","), postPromotePaths(pages, shells));
});
