import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const boundedReleaseSmokePattern =
  /node e2e\/release-smoke-ci\.mjs/;

test("local web release script enforces build, preview deploy, smoke, and explicit promotion", () => {
  const script = read("scripts/release-web.sh");

  assert.match(script, /stage "build"/);
  assert.match(script, /stage "firebase-client-preflight"/);
  assert.match(script, /stage "stripe-price-preflight"/);
  assert.match(script, /npm run firebase:preflight/);
  assert.match(script, /npm run stripe:preflight/);
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
  assert.match(script, boundedReleaseSmokePattern);
  assert.match(script, /src\/app\/reports\/__tests__\/page-runtime\.test\.tsx/);

  const buildIndex = script.indexOf('stage "build"');
  const firebasePreflightIndex = script.indexOf('stage "firebase-client-preflight"');
  const stripePreflightIndex = script.indexOf('stage "stripe-price-preflight"');
  const vercelBuildIndex = script.indexOf('stage "vercel-build"');
  const previewIndex = script.indexOf('stage "deploy-preview"');
  const smokeIndex = script.indexOf('stage "smoke"');
  const promoteIndex = script.indexOf('stage "promote-prod"');
  assert.ok(firebasePreflightIndex < buildIndex, "Firebase client preflight must run before build");
  assert.ok(stripePreflightIndex < buildIndex, "Stripe price preflight must run before build");
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
  assert.match(workflow, /STRIPE_PRO_PRICE_ID:\s*\$\{\{\s*secrets\.STRIPE_PRO_PRICE_ID\s*\}\}/);
  assert.match(workflow, /NEXT_PUBLIC_FIREBASE_API_KEY:\s*\$\{\{\s*secrets\.NEXT_PUBLIC_FIREBASE_API_KEY_PROD\s*\}\}/);
  assert.match(workflow, /npm --prefix web run firebase:preflight/);
  assert.match(workflow, /npm --prefix web run stripe:preflight/);
  assert.match(workflow, /add_env_pair "NEXT_PUBLIC_FIREBASE_API_KEY" "\$\{NEXT_PUBLIC_FIREBASE_API_KEY:-\}"/);
  assert.match(workflow, /--prebuilt/);
  assert.match(workflow, /--target\s+production/);
  assert.match(workflow, /--force/);
  assert.match(workflow, /--skip-domain/);
  assert.match(workflow, /NPM_CONFIG_FETCH_RETRIES:\s*"5"/);
  assert.match(workflow, /vercel promote/);
  assert.match(workflow, /smoke-preview:[\s\S]*timeout-minutes:\s*25/);
  assert.match(workflow, /Run release smoke[\s\S]*timeout-minutes:\s*12/);
  assert.match(workflow, boundedReleaseSmokePattern);
  assert.match(workflow, /CLOUDFLARE_TESTING_BYPASS_SECRET/);
});

test("post-deploy smoke uses trusted-test headers and full production release smoke", () => {
  const workflow = read(".github/workflows/post-deploy-smoke.yml");

  assert.match(workflow, /CLOUDFLARE_TESTING_BYPASS_SECRET/);
  assert.match(workflow, /Shorted-E2E\/1\.0/);
  assert.match(workflow, /X-Shorted-Testing-Bypass/);
  assert.match(workflow, /CURL_ARGS/);
  assert.match(workflow, /\[\s*"\$status"\s*-ge 400\s*\]/);
  assert.doesNotMatch(workflow, /\[\s*"\$status"\s*-ge 500\s*\]/);
  assert.match(workflow, /actions\/checkout@v5/);
  assert.match(workflow, /node-version:\s*"24"/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npx playwright install --with-deps chromium/);
  assert.match(workflow, /timeout-minutes:\s*25/);
  assert.match(workflow, /timeout-minutes:\s*12/);
  assert.match(workflow, /BASE_URL:\s*https:\/\/shorted\.com\.au/);
  assert.match(workflow, /RELEASE_API_BASE_URL:\s*https:\/\/api\.shorted\.com\.au/);
  assert.match(workflow, boundedReleaseSmokePattern);
  assert.match(workflow, /CLOUDFLARE_TESTING_BYPASS_SECRET is required/);
  assert.match(workflow, /post-deploy-smoke-playwright-report/);
});

test("legacy terraform production web deploy also smokes a preview before promotion", () => {
  const workflow = read(".github/workflows/terraform-deploy.yml");
  const prodJobStart = workflow.indexOf("deploy-vercel-prod:");
  assert.notEqual(prodJobStart, -1, "deploy-vercel-prod job should exist");
  const prodJob = workflow.slice(prodJobStart);
  const bypassEnvMatches = workflow.match(
    /TF_VAR_rate_limit_testing_bypass_secret:\s*\$\{\{\s*secrets\.CLOUDFLARE_TESTING_BYPASS_SECRET\s*\}\}/g,
  ) ?? [];

  assert.match(prodJob, /Deploy to Vercel \(Release Candidate Preview\)/);
  assert.doesNotMatch(prodJob, /Deploy to Vercel \(Production\)[\s\S]*--prod/);
  assert.match(prodJob, /vercel build/);
  assert.match(prodJob, /npm --prefix web run firebase:preflight/);
  assert.match(prodJob, /npm --prefix web run stripe:preflight/);
  assert.match(prodJob, /--prebuilt/);
  assert.match(prodJob, /--target\s+production/);
  assert.match(prodJob, /--force/);
  assert.match(prodJob, /--skip-domain/);
  assert.match(prodJob, /NPM_CONFIG_FETCH_RETRIES:\s*"5"/);
  assert.match(prodJob, /Smoke release candidate preview/);
  assert.match(prodJob, /Smoke release candidate preview[\s\S]*timeout-minutes:\s*12/);
  assert.match(prodJob, boundedReleaseSmokePattern);
  assert.match(prodJob, /Promote smoked Vercel deployment to production/);
  assert.match(prodJob, /vercel promote/);
  assert.match(workflow, /check_secret "GEMINI_API_KEY"/);
  assert.match(workflow, /check_optional_secret "STRIPE_API_ACCESS_PRICE_ID"/);
  assert.match(workflow, /STRIPE_PRO_PRICE_ID:\s*\$\{\{\s*secrets\.STRIPE_PRO_PRICE_ID\s*\}\}/);
  assert.match(workflow, /NEXT_PUBLIC_FIREBASE_API_KEY:\s*\$\{\{\s*secrets\.NEXT_PUBLIC_FIREBASE_API_KEY_PROD\s*\}\}/);
  assert.doesNotMatch(workflow, /check_secret "STRIPE_API_ACCESS_PRICE_ID"/);
  assert.match(workflow, /GEMINI_API_KEY:\s*\$\{\{\s*secrets\.GEMINI_API_KEY\s*\}\}/);
  assert.match(workflow, /ensure_secret "GEMINI_API_KEY_CHAT" "\$GEMINI_API_KEY"/);
  assert.match(workflow, /ensure_secret "GEMINI_API_KEY_NEWS" "\$GEMINI_API_KEY"/);
  assert.match(workflow, /ensure_secret "GEMINI_API_KEY_REPORT_EXTRACTOR" "\$GEMINI_API_KEY"/);
  assert.doesNotMatch(
    workflow,
    /STRIPE_API_ACCESS_PRICE_ID[^\n]*secrets\.STRIPE_PRO_PRICE_ID/,
    "API Access price must not fall back to the Premium/Pro price",
  );
  assert.ok(
    bypassEnvMatches.length >= 2,
    "terraform plan/apply must preserve the Cloudflare trusted-test bypass secret",
  );

  const previewIndex = prodJob.indexOf("Deploy to Vercel (Release Candidate Preview)");
  const smokeIndex = prodJob.indexOf("Smoke release candidate preview");
  const promoteIndex = prodJob.indexOf("Promote smoked Vercel deployment to production");
  assert.ok(previewIndex < smokeIndex, "production workflow must deploy preview before smoke");
  assert.ok(smokeIndex < promoteIndex, "production workflow must smoke before promote");
});

test("release smoke covers prior regression surfaces and Cloudflare API checks", () => {
  const spec = read("web/e2e/release-smoke.spec.ts");
  const helper = read("web/e2e/helpers/cloudflare-testing-bypass.ts");
  const firebaseAuthHelper = read("web/e2e/helpers/firebase-google-auth-bootstrap.mjs");

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
  assert.match(spec, /cloudflareTestingBypassHeaders/);
  assert.match(spec, /setExtraHTTPHeaders\(releaseHeaders\(\)\)/);
  const ciRunner = read("web/e2e/release-smoke-ci.mjs");
  assert.match(ciRunner, /release smoke passed/);
  assert.match(ciRunner, /GetCompanyTaxProfile/);
  assert.match(ciRunner, /checkFirebaseGoogleAuthBootstrap/);
  assert.match(ciRunner, /check Firebase Google auth bootstrap/);
  assert.match(spec, /checkFirebaseGoogleAuthBootstrap/);
  assert.match(spec, /Firebase Google sign-in bootstrap creates an auth URI with valid API key/);
  assert.match(ciRunner, /cdn-cgi\/rum/);
  assert.match(spec, /GetCompanyTaxProfile/);
  assert.match(spec, /isIgnorableAppApiFailure/);
  assert.match(spec, /cdn-cgi\/rum/);
  assert.match(spec, /Element type is invalid/);
  assert.match(spec, /Page changed from static to dynamic/);
  assert.match(spec, /cf-mitigated/);
  assert.match(spec, /GetStockData/);
  assert.match(spec, /GetTopShorts/);
  assert.match(spec, /cloudflareinsights\.com/);
  assert.match(spec, /isIgnorableConsoleError/);

  assert.match(helper, /X-Shorted-Testing-Bypass/);
  assert.match(helper, /Shorted-E2E\/1\.0/);
  assert.match(firebaseAuthHelper, /identityToolkitOk/);
  assert.match(firebaseAuthHelper, /authUriCreated/);
  assert.match(firebaseAuthHelper, /authUriProbeOk/);
  assert.match(firebaseAuthHelper, /accounts:createAuthUri/);
  assert.match(firebaseAuthHelper, /escapedNewlineKey/);
  assert.match(firebaseAuthHelper, /apiKeyInvalid/);
  assert.match(firebaseAuthHelper, /googleOAuthSeen/);
});

test("Playwright config applies Cloudflare trusted-test headers across browser projects", () => {
  const config = read("web/playwright.config.ts");
  const helper = read("web/e2e/helpers/cloudflare-testing-bypass.ts");

  assert.match(config, /cloudflareTestingBypassHeaders/);
  assert.match(config, /withCloudflareTestingUserAgent/);
  assert.match(config, /extraHTTPHeaders:\s*baseExtraHTTPHeaders/);
  assert.match(config, /deviceUse\(devices\["Desktop Chrome"\]\)/);
  assert.match(config, /deviceUse\(devices\["Desktop Firefox"\]\)/);
  assert.match(config, /deviceUse\(devices\["Desktop Safari"\]\)/);
  assert.match(config, /deviceUse\(devices\["Pixel 5"\]\)/);
  assert.match(config, /deviceUse\(devices\["iPhone 12"\]\)/);

  assert.match(helper, /CLOUDFLARE_TESTING_BYPASS_SECRET/);
  assert.match(helper, /SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET/);
  assert.match(helper, /TF_VAR_rate_limit_testing_bypass_secret/);
  assert.match(helper, /X-Shorted-Testing-Bypass/);
  assert.match(helper, /Shorted-E2E\/1\.0/);
});

test("release docs document Firebase auth validation gates", () => {
  const releaseDocs = read("docs/RELEASE_PROCESS.md");
  const productionDocs = read("docs/PRODUCTION_DEPLOYMENT.md");
  const firebaseDocs = read("docs/FIREBASE_AUTH_VALIDATION.md");
  const claude = read("CLAUDE.md");

  for (const doc of [releaseDocs, productionDocs, firebaseDocs, claude]) {
    assert.match(doc, /firebase:preflight/);
    assert.match(doc, /Firebase Google sign-in bootstrap/);
    assert.match(doc, /API_KEY_INVALID/);
    assert.match(doc, /escaped newline/i);
  }

  assert.match(firebaseDocs, /identitytoolkit\.googleapis\.com/);
  assert.match(firebaseDocs, /x-shorted-testing-bypass/);
  assert.match(firebaseDocs, /NEXT_PUBLIC_FIREBASE_API_KEY_PROD/);
});
