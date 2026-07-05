import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("local web release script enforces build, preview deploy, smoke, and explicit promotion", () => {
  const script = read("scripts/release-web.sh");

  assert.match(script, /stage "build"/);
  assert.match(script, /stage "vercel-build"/);
  assert.match(script, /stage "deploy-preview"/);
  assert.match(script, /stage "smoke"/);
  assert.match(script, /stage "promote-prod"/);
  assert.match(script, /rm -rf "\$WEB_DIR\/\.next" "\$ROOT_DIR\/\.vercel\/output" "\$WEB_DIR\/\.vercel\/output"/);
  assert.match(script, /vercel build/);
  assert.match(script, /vercel deploy(?![^\n]*--prod)/);
  assert.match(script, /"--prebuilt"/);
  assert.match(script, /"--target" "production"/);
  assert.match(script, /"--force"/);
  assert.match(script, /"--skip-domain"/);
  assert.match(script, /vercel promote/);
  assert.match(script, /RELEASE_CONFIRM_PROMOTE=1/);
  assert.match(script, /npx playwright test e2e\/release-smoke\.spec\.ts/);
  assert.match(script, /src\/app\/reports\/__tests__\/page-runtime\.test\.tsx/);

  const buildIndex = script.indexOf('stage "build"');
  const vercelBuildIndex = script.indexOf('stage "vercel-build"');
  const previewIndex = script.indexOf('stage "deploy-preview"');
  const smokeIndex = script.indexOf('stage "smoke"');
  const promoteIndex = script.indexOf('stage "promote-prod"');
  assert.ok(buildIndex < vercelBuildIndex, "local build must run before vercel build");
  assert.ok(vercelBuildIndex < previewIndex, "vercel build must run before preview deploy");
  assert.ok(previewIndex < smokeIndex, "preview deploy must run before smoke");
  assert.ok(smokeIndex < promoteIndex, "smoke must run before promotion");
});

test("GitHub release workflow gates production promotion on preview smoke", () => {
  const workflow = read(".github/workflows/release-preview-smoke.yml");

  assert.match(workflow, /name:\s*Release Preview Smoke/);
  assert.match(workflow, /deploy-preview:/);
  assert.match(workflow, /smoke-preview:/);
  assert.match(workflow, /promote-production:/);
  assert.match(workflow, /needs:\s*\[deploy-preview, smoke-preview\]/);
  assert.match(workflow, /vercel deploy/);
  assert.match(workflow, /vercel build/);
  assert.match(workflow, /--prebuilt/);
  assert.match(workflow, /--target\s+production/);
  assert.match(workflow, /--force/);
  assert.match(workflow, /--skip-domain/);
  assert.match(workflow, /vercel promote/);
  assert.match(workflow, /npx playwright test e2e\/release-smoke\.spec\.ts/);
  assert.match(workflow, /CLOUDFLARE_TESTING_BYPASS_SECRET/);
});

test("legacy terraform production web deploy also smokes a preview before promotion", () => {
  const workflow = read(".github/workflows/terraform-deploy.yml");
  const prodJobStart = workflow.indexOf("deploy-vercel-prod:");
  assert.notEqual(prodJobStart, -1, "deploy-vercel-prod job should exist");
  const prodJob = workflow.slice(prodJobStart);

  assert.match(prodJob, /Deploy to Vercel \(Release Candidate Preview\)/);
  assert.doesNotMatch(prodJob, /Deploy to Vercel \(Production\)[\s\S]*--prod/);
  assert.match(prodJob, /vercel build/);
  assert.match(prodJob, /--prebuilt/);
  assert.match(prodJob, /--target\s+production/);
  assert.match(prodJob, /--force/);
  assert.match(prodJob, /--skip-domain/);
  assert.match(prodJob, /Smoke release candidate preview/);
  assert.match(prodJob, /npx playwright test e2e\/release-smoke\.spec\.ts/);
  assert.match(prodJob, /Promote smoked Vercel deployment to production/);
  assert.match(prodJob, /vercel promote/);

  const previewIndex = prodJob.indexOf("Deploy to Vercel (Release Candidate Preview)");
  const smokeIndex = prodJob.indexOf("Smoke release candidate preview");
  const promoteIndex = prodJob.indexOf("Promote smoked Vercel deployment to production");
  assert.ok(previewIndex < smokeIndex, "production workflow must deploy preview before smoke");
  assert.ok(smokeIndex < promoteIndex, "production workflow must smoke before promote");
});

test("release smoke covers prior regression surfaces and Cloudflare API checks", () => {
  const spec = read("web/e2e/release-smoke.spec.ts");

  for (const path of [
    "/shorts/LOT",
    "/housing",
    "/news",
    "/market/2024-08-21",
    "/reports",
    "/reports/weekly/2026-W25",
    "/reports/monthly/2026-06",
    "/reports/yearly/2025",
  ]) {
    assert.match(spec, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(spec, /api\.shorted\.com\.au/);
  assert.match(spec, /X-Shorted-Testing-Bypass/);
  assert.match(spec, /Shorted-E2E\/1\.0/);
  assert.match(spec, /setExtraHTTPHeaders\(releaseHeaders\(\)\)/);
  assert.match(spec, /Element type is invalid/);
  assert.match(spec, /Page changed from static to dynamic/);
  assert.match(spec, /cf-mitigated/);
  assert.match(spec, /GetStockData/);
  assert.match(spec, /GetTopShorts/);
  assert.match(spec, /cloudflareinsights\.com/);
  assert.match(spec, /isIgnorableConsoleError/);
});
