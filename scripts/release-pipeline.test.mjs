import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

test("CI has no PR preview workflow or dangling preview-job dependency", () => {
  assert.equal(existsSync(new URL("../.github/workflows/release-preview-smoke.yml", import.meta.url)), false);
  for (const file of readdirSync(new URL("../.github/workflows", import.meta.url))) {
    if (!/\.ya?ml$/.test(file)) continue;
    const workflow = read(`.github/workflows/${file}`);
    assert.doesNotMatch(workflow, /^ {2}(deploy-preview|smoke-preview|promote-production):/m, file);
    assert.doesNotMatch(workflow, /needs\.(deploy-preview|smoke-preview)\./, file);
    assert.doesNotMatch(workflow, /needs:[^\n]*(deploy-preview|smoke-preview)/, file);
  }
});

test("bundle CI remains blocking without a browser or Lighthouse server", () => {
  const workflow = read(".github/workflows/perf-budget.yml");
  assert.match(workflow, /name: Bundle budget/);
  assert.match(workflow, /set -(?:euo|o) pipefail/);
  assert.match(workflow, /npx next build 2>&1 \| tee perf-results\/build\.log/);
  assert.match(workflow, /node scripts\/bundle-budget\.mjs --build-log perf-results\/build\.log --compare \.\.\/docs\/perf\/bundle-baseline\.json/);
  assert.doesNotMatch(workflow, /continue-on-error|lighthouse-bench|playwright install|next start|Start production server/);
  assert.match(workflow, /path: web\/perf-results\/bundle-\*\.json/);
  assert.ok(workflow.indexOf("Production build") < workflow.indexOf("Bundle budget vs baseline"));
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

test("production web deploy preserves preflights, artifact promotion and test gates without preview smoke", () => {
  const workflow = read(".github/workflows/terraform-deploy.yml");
  const prodJobStart = workflow.indexOf("deploy-vercel-prod:");
  assert.notEqual(prodJobStart, -1, "deploy-vercel-prod job should exist");
  const prodJob = workflow.slice(prodJobStart);
  const bypassEnvMatches = workflow.match(
    /TF_VAR_rate_limit_testing_bypass_secret:\s*\$\{\{\s*secrets\.CLOUDFLARE_TESTING_BYPASS_SECRET\s*\}\}/g,
  ) ?? [];

  assert.match(prodJob, /Build and upload production deployment/);
  assert.doesNotMatch(prodJob, /Deploy to Vercel \(Production\)[\s\S]*--prod/);
  assert.match(prodJob, /vercel build/);
  assert.match(prodJob, /npm --prefix web run firebase:preflight/);
  assert.match(prodJob, /npm --prefix web run stripe:preflight/);
  assert.match(prodJob, /--prebuilt/);
  assert.match(prodJob, /--target\s+production/);
  assert.match(prodJob, /--force/);
  assert.match(prodJob, /--skip-domain/);
  assert.match(prodJob, /NPM_CONFIG_FETCH_RETRIES:\s*"5"/);
  // Preview smoke remains excluded, but the promoted release must be tested.
  const beforePromotion = prodJob.slice(0, prodJob.indexOf("Promote Vercel deployment to production"));
  assert.doesNotMatch(beforePromotion, /Smoke release candidate preview|release-smoke-ci\.mjs|playwright install/);
  assert.doesNotMatch(prodJob, /Smoke release candidate preview/);
  const smokeIndex = prodJob.indexOf("Verify promoted production release");
  const summaryIndex = prodJob.indexOf("Production Deployment Summary");
  assert.ok(smokeIndex > prodJob.indexOf("Promote Vercel deployment to production"));
  assert.ok(summaryIndex > smokeIndex, "deployment success must follow release smoke");
  assert.match(prodJob.slice(smokeIndex, summaryIndex), boundedReleaseSmokePattern);
  assert.match(prodJob, /Promote Vercel deployment to production/);
  assert.match(prodJob, /vercel promote/);
  assert.match(workflow, /check_secret "GEMINI_API_KEY"/);
  assert.match(workflow, /check_optional_secret "STRIPE_API_ACCESS_PRICE_ID"/);
  assert.match(workflow, /STRIPE_PRO_PRICE_ID:\s*\$\{\{\s*secrets\.STRIPE_PRO_PRICE_ID\s*\}\}/);
  assert.match(workflow, /NEXT_PUBLIC_FIREBASE_API_KEY:\s*\$\{\{\s*secrets\.NEXT_PUBLIC_FIREBASE_API_KEY_PROD\s*\}\}/);
  assert.doesNotMatch(workflow, /check_secret "STRIPE_API_ACCESS_PRICE_ID"/);
  assert.match(workflow, /GEMINI_API_KEY:\s*\$\{\{\s*secrets\.GEMINI_API_KEY\s*\}\}/);
  // The chat key prefers its own secret and falls back to the shared one
  // (terraform-deploy-workflow.test.mjs pins both jobs).
  // Every Gemini sync goes through ensure_gemini_secret, which validates the key
  // first (terraform-deploy-workflow.test.mjs pins both jobs).
  assert.match(workflow, /ensure_gemini_secret "GEMINI_API_KEY_CHAT" "\$\{GEMINI_API_KEY_CHAT:-\$GEMINI_API_KEY\}"/);
  assert.match(workflow, /ensure_gemini_secret "GEMINI_API_KEY_NEWS" "\$GEMINI_API_KEY"/);
  assert.match(workflow, /ensure_gemini_secret "GEMINI_API_KEY_REPORT_EXTRACTOR" "\$GEMINI_API_KEY"/);
  assert.doesNotMatch(
    workflow,
    /STRIPE_API_ACCESS_PRICE_ID[^\n]*secrets\.STRIPE_PRO_PRICE_ID/,
    "API Access price must not fall back to the Premium/Pro price",
  );
  assert.ok(
    bypassEnvMatches.length >= 2,
    "terraform plan/apply must preserve the Cloudflare trusted-test bypass secret",
  );

  const uploadIndex = prodJob.indexOf("Build and upload production deployment");
  const promoteIndex = prodJob.indexOf("Promote Vercel deployment to production");
  assert.ok(uploadIndex < promoteIndex, "promote must use the uploaded artifact");
  assert.ok(prodJob.indexOf("Set up Node for production deployment") < uploadIndex, "Node must exist before build/upload");
  assert.match(prodJob, /DEPLOYMENT_URL: \$\{\{ steps\.vercel-deploy\.outputs\.deployment-url \}\}/);
  assert.match(prodJob, /vercel promote "\$DEPLOYMENT_URL"/);
  assert.match(prodJob, /environment: prod/);
  const gate = prodJob.slice(0, prodJob.indexOf("    steps:"));
  assert.match(gate, /needs:[^\n]*run-tests/);
  assert.match(gate, /needs\.run-tests\.result == 'success'/);
  assert.match(gate, /needs\.validate-secrets\.result == 'success'/);
  assert.match(gate, /github\.event_name != 'pull_request'/);
  assert.match(gate, /github\.event\.inputs\.plan_only != 'true'/);
});

test("production promotion condition rejects PRs, failed checks, failed applies and plan-only runs", () => {
  const workflow = read(".github/workflows/terraform-deploy.yml");
  const job = workflow.slice(workflow.indexOf("  deploy-vercel-prod:"));
  const expression = job.match(/    if: \|\n([\s\S]*?)    environment: prod/)[1]
    .trim().replace(/\bneeds\.([\w-]+)/g, 'needs["$1"]');
  // Evaluate the actual simple GitHub condition with completed job results.
  const eligible = new Function("github", "needs", "always", `return (${expression});`);
  // The web release ships only against infrastructure that applied: a failed,
  // cancelled or skipped terraform-apply would promote it against the old API.
  const cases = [
    ["main with passing tests and a successful apply", "push", "success", "success", "success", false, true],
    ["pull request", "pull_request", "success", "success", "success", false, false],
    ["failed tests", "push", "failure", "success", "success", false, false],
    ["cancelled tests", "push", "cancelled", "success", "success", false, false],
    ["failed secrets", "push", "success", "failure", "success", false, false],
    ["failed apply", "push", "success", "success", "failure", false, false],
    ["cancelled apply", "push", "success", "success", "cancelled", false, false],
    ["skipped apply", "push", "success", "success", "skipped", false, false],
    ["plan-only dispatch", "workflow_dispatch", "success", "success", "skipped", true, false],
    ["manual dispatch with passing tests and a successful apply", "workflow_dispatch", "success", "success", "success", false, true],
    ["published tag release with passing tests and a successful apply", "release", "success", "success", "success", false, true],
  ];
  for (const [name, event, tests, secrets, apply, planOnly, expected] of cases) {
    assert.equal(eligible({ event_name: event, event: { inputs: { plan_only: String(planOnly) } } }, {
      "determine-environment": { outputs: { environment: "prod" } },
      "run-tests": { result: tests }, "validate-secrets": { result: secrets },
      "terraform-apply": { result: apply },
    }, () => true), expected, name);
  }
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

test("Playwright sends the Cloudflare trusted-test header to our own origins only", () => {
  const config = read("web/playwright.config.ts");
  const helper = read("web/e2e/helpers/cloudflare-testing-bypass.ts");
  const fixture = read("web/e2e/helpers/test.ts");

  // extraHTTPHeaders go to every host a page contacts, Google's included.
  assert.doesNotMatch(config, /cloudflareTestingBypassHeaders/);
  assert.match(fixture, /routeTestingBypass\(context, cloudflareTestingBypassHeaders\(\)\)/);
  assert.match(fixture, /scopeTestingBypassRequests\(request, baseURL, cloudflareTestingBypassHeaders\(\)\)/);
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


test("the web release passes both Stripe price ids, so a Premium price is never dropped", () => {
  // Premium is written from STRIPE_PREMIUM_PRICE_ID (and the legacy STRIPE_PRO_PRICE_ID).
  // A release that passes only the legacy name leaves the current Premium price unset
  // on the web, and every checkout and sync then refuses it as unconfigured.
  const script = read("scripts/release-web.sh");

  assert.match(script, /append_endpoint_args "STRIPE_PREMIUM_PRICE_ID" "\$\{STRIPE_PREMIUM_PRICE_ID:-\}"/);
  assert.match(script, /append_endpoint_args "STRIPE_PRO_PRICE_ID" "\$\{STRIPE_PRO_PRICE_ID:-\}"/);
});
