# Web Release Process

For release failures or production regressions, use `$shorted-prod-troubleshooting` first. The skill lives at `/Users/benebsworth/.codex/skills/shorted-prod-troubleshooting/SKILL.md` and covers logs, metrics, Cloudflare RUM, build/hook success, E2E smoke, Vercel, Cloudflare wrangler, API edge, and data checks.

CI uses one production path in `terraform-deploy.yml`:

1. Run the existing tests and validate deployment secrets.
2. Run Firebase and Stripe preflights, then `vercel build --target production`.
3. Upload the production artifact with `vercel deploy --prebuilt --target production --skip-domain`.
4. Promote that exact deployment with `vercel promote` and revalidate ISR pages.
5. Verify the live site with the existing Post-Deploy Smoke Test workflow.

PRs do not deploy Vercel previews or run preview browser smoke. The Perf Budget
workflow retains its production build and blocking bundle-size comparison; it
no longer installs Chromium, starts a server or runs Lighthouse. The Lighthouse
CLI and local release/browser tests remain available for deliberate local checks.
The retired `release-preview-smoke.yml` workflow is removed, including its duplicate
main promotion. CI no longer provides a separate web-only manual preview release.

## Local Release

Dry run through preview and smoke:

```bash
npm run release:web
```

Promote after the preview smoke passes:

```bash
PROMOTE_TO_PROD=1 RELEASE_CONFIRM_PROMOTE=1 npm run release:web
```

The local script removes `web/.next`, `.vercel/output`, and `web/.vercel/output` before building, runs `vercel build --target production`, then deploys the release candidate with `vercel deploy --prebuilt --target production --force --skip-domain`. Production aliases only move through `vercel promote` after the smoke suite passes.

## Release Validation Gates

The release path must fail before deploy if client auth or payments are misconfigured:

- `npm --prefix web run firebase:preflight` validates required public Firebase config, normalizes escaped newline values, and checks the API key against `identitytoolkit.googleapis.com`.
- `npm --prefix web run stripe:preflight` validates configured Stripe checkout price IDs against the active Stripe account.
- `node e2e/release-smoke-ci.mjs` includes the Firebase Google sign-in bootstrap check. It opens `/signin`, clicks "Continue with Google", verifies Identity Toolkit returns 200 responses, rejects `API_KEY_INVALID`, rejects escaped newline API keys, and confirms Firebase can create a Google auth URI through the browser flow or direct Identity Toolkit probe.

Firebase and Stripe preflights remain mandatory in `scripts/release-web.sh` and `.github/workflows/terraform-deploy.yml`. Browser bootstrap runs in the local release and production post-deploy smoke; it is no longer a CI pre-promotion gate. `node --test scripts/release-pipeline.test.mjs` asserts these contracts.

Firebase auth details and triage commands live in `docs/FIREBASE_AUTH_VALIDATION.md`.

Useful environment overrides:

```bash
export VERCEL_TOKEN="..."
export VERCEL_SCOPE="document-analyser"
export RELEASE_API_BASE_URL="https://api.shorted.com.au"
export CLOUDFLARE_TESTING_BYPASS_SECRET="..."
export RELEASE_SHORTS_SERVICE_ENDPOINT="https://shorts-...a.run.app"
export RELEASE_MARKET_DATA_API_URL="https://market-data-...a.run.app"
```

`CLOUDFLARE_TESTING_BYPASS_SECRET` must match the Cloudflare rate-limit testing bypass secret. Release smoke uses a browser-like user-agent containing the E2E marker, and sends the bypass secret when configured:

- `User-Agent: ... Shorted-E2E/1.0`
- `X-Shorted-Testing-Bypass: <secret>`

To create or rotate the bypass, apply the same generated value to Cloudflare Terraform and GitHub Actions:

```bash
export CLOUDFLARE_TESTING_BYPASS_SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"

cd terraform/environments/prod
export TF_VAR_rate_limit_testing_bypass_secret="$CLOUDFLARE_TESTING_BYPASS_SECRET"
terraform plan
terraform apply

gh secret set CLOUDFLARE_TESTING_BYPASS_SECRET \
  --repo castlemilk/shorted.com.au \
  --body "$CLOUDFLARE_TESTING_BYPASS_SECRET"
```

Smoke against `https://shorted.com.au` should include that secret. Without it, Cloudflare may return 403s for browser-loaded resources during Playwright runs; smoke the emitted Vercel deployment URL when the secret is not available locally.

The shared Playwright config applies the same bypass automatically for all browser/API test contexts when the secret is present. The helper lives at `web/e2e/helpers/cloudflare-testing-bypass.ts` and reads, in order:

- `CLOUDFLARE_TESTING_BYPASS_SECRET`
- `SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET`
- `TF_VAR_rate_limit_testing_bypass_secret`

GitHub post-deploy curl smoke also sends `User-Agent: Mozilla/5.0 Shorted-E2E/1.0` and the secret header when the repository secret is configured.

## Post-Deployment Verification

The **Post-Deploy Smoke Test** workflow is the production health check after main-branch deploys, scheduled checks, and manual verification runs. It performs two layers:

1. Fast curl checks for key pages and lightweight API endpoints through `https://shorted.com.au`, always with the trusted-test user-agent and secret header.
2. The full `web/e2e/release-smoke.spec.ts` suite against `BASE_URL=https://shorted.com.au` and `RELEASE_API_BASE_URL=https://api.shorted.com.au`.

The workflow must fail if `CLOUDFLARE_TESTING_BYPASS_SECRET` is missing. Browser-based production smoke goes through Cloudflare, so the secret is required to avoid false failures from bot challenges or rate limits while preserving managed WAF and app-level permissions.

Run it manually after infrastructure or release-process changes:

```bash
gh workflow run post-deploy-smoke.yml --ref main
```

For local production verification, use the same command shape:

```bash
cd web
set -a; source ../.env; set +a
export CLOUDFLARE_TESTING_BYPASS_SECRET="${CLOUDFLARE_TESTING_BYPASS_SECRET:-$TF_VAR_rate_limit_testing_bypass_secret}"
BASE_URL=https://shorted.com.au \
RELEASE_API_BASE_URL=https://api.shorted.com.au \
CLOUDFLARE_TESTING_BYPASS_SECRET="$CLOUDFLARE_TESTING_BYPASS_SECRET" \
node e2e/release-smoke-ci.mjs
```

If production smoke sees a Cloudflare challenge despite both headers, verify the live `shorted-app-api-security-skip` ruleset in phase `http_request_firewall_custom` is not using the disabled sentinel expression `http.host eq "__shorted-testing-bypass-disabled.invalid__"`. The GitHub repository secret `CLOUDFLARE_TESTING_BYPASS_SECRET` and Terraform variable `TF_VAR_rate_limit_testing_bypass_secret` must match after any rotation. Re-check this after Terraform or Cloudflare deploys, because applying Terraform without the Terraform secret variable can restore the disabled expression.

## GitHub Release

Use **Deploy Infrastructure** (`terraform-deploy.yml`) for production CI.
Main pushes and the existing release/manual triggers retain the `prod` environment
protection. PRs cannot promote. `plan_only=true` cannot deploy the frontend, and
production web promotion explicitly requires successful tests and secret validation.
The existing service-URL fallback after a Terraform failure remains, subject to
those test and secret gates. Manual/release runs still depend on their existing
cloud identity policy; this change grants no additional access.

The upload uses `--skip-domain` so a failed upload cannot move production aliases.
The following `vercel promote` step moves the domain to that same artifact, without
a preview browser-smoke stage. Production post-deploy smoke still runs on main,
on its existing schedule and by manual dispatch. It is a health check after release,
not a prerequisite to promotion. The local release script keeps its preview/smoke
and explicit-promotion behavior.

## Required Secrets

- `VERCEL_TOKEN`
- `CLOUDFLARE_TESTING_BYPASS_SECRET`
- `NEXT_PUBLIC_FIREBASE_API_KEY_PROD`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN_PROD`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID_PROD`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET_PROD`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID_PROD`
- `NEXT_PUBLIC_FIREBASE_APP_ID_PROD`

Production CI resolves service endpoints from Terraform outputs or its existing Cloud Run fallback. `RELEASE_SHORTS_SERVICE_ENDPOINT` and `RELEASE_MARKET_DATA_API_URL` remain optional local release overrides.
