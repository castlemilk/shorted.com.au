import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../web/scripts/warm-cache-on-deploy.sh", import.meta.url));

// Runs the postbuild script with a stand-in curl that logs each call's arguments
// and sends nothing. The secrets are fixtures, not credentials.
function runPostbuild(env) {
  const dir = mkdtempSync(join(tmpdir(), "warm-cache-on-deploy-"));
  try {
    const bin = join(dir, "bin");
    const log = join(dir, "calls.log");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const result = spawnSync("/bin/sh", [script], {
      env: { PATH: `${bin}:/usr/bin:/bin`, NODE_ENV: "production", ...env },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    try {
      return readFileSync(log, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the localhost fallback gets no credentials, since it is plain http", () => {
  const calls = runPostbuild({ REVALIDATION_SECRET: "reval-fixture", CACHE_WARM_SECRET: "warm-fixture" });
  assert.ok(calls.length >= 2, `expected warm calls, got ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /http:\/\/localhost:3020\//);
    assert.doesNotMatch(call, /Authorization|X-Cache-Warm-Secret|reval-fixture|warm-fixture/);
  }
});

test("an https deployment gets the revalidation bearer and the warm header", () => {
  const calls = runPostbuild({
    VERCEL_URL: "preview.example.test",
    REVALIDATION_SECRET: "reval-fixture",
    CACHE_WARM_SECRET: "warm-fixture",
  });
  const warm = calls.filter((call) => /\/api\/(about|homepage)\/warm-cache$/.test(call));
  assert.equal(warm.length, 2);
  for (const call of warm) {
    assert.match(call, /^-f -s --max-time 30 /);
    assert.match(call, /https:\/\/preview\.example\.test\/api\//);
    assert.match(call, /-H Authorization: Bearer reval-fixture/);
    assert.match(call, /-H X-Cache-Warm-Secret: warm-fixture/);
  }
});

test("an explicit http VERCEL_URL gets no credentials either", () => {
  const calls = runPostbuild({ VERCEL_URL: "http://preview.example.test", REVALIDATION_SECRET: "reval-fixture" });
  assert.ok(calls.length >= 2, `expected warm calls, got ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /http:\/\/preview\.example\.test\//);
    assert.doesNotMatch(call, /Authorization|reval-fixture/);
  }
});
