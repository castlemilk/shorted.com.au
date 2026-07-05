# Web Release Process

For release failures or production regressions, use `$shorted-prod-troubleshooting` first. The skill lives at `/Users/benebsworth/.codex/skills/shorted-prod-troubleshooting/SKILL.md` and covers logs, metrics, Cloudflare RUM, build/hook success, E2E smoke, Vercel, Cloudflare wrangler, API edge, and data checks.

This is the required release shape for the Shorted web app:

1. Clean generated build output, then build and run release guards.
2. Build the Vercel artifact locally with `vercel build --target production`.
3. Deploy that artifact as a production-target release candidate with `vercel deploy --prebuilt --target production --skip-domain`.
4. Run `web/e2e/release-smoke.spec.ts` against that exact preview URL.
5. Promote the same Vercel deployment to production only after smoke passes.
6. Keep post-production smoke as monitoring, not as the first gate.

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

Smoke against `https://shorted.com.au` should include that secret. Without it, Cloudflare may return 403s for browser-loaded resources during Playwright runs; smoke the emitted Vercel deployment URL when the secret is not available locally.

## GitHub Release

Use **Release Preview Smoke** from GitHub Actions.

- Pull requests deploy and smoke a preview only.
- Manual dispatch with `promote=false` deploys and smokes a release candidate.
- Manual dispatch with `promote=true` promotes the smoked preview deployment to production.

The existing production path in `terraform-deploy.yml` also follows the same shape for the web app: release-candidate preview, smoke, then `vercel promote`.

## Required Secrets

- `VERCEL_TOKEN`
- `CLOUDFLARE_TESTING_BYPASS_SECRET`
- Optional `RELEASE_SHORTS_SERVICE_ENDPOINT`
- Optional `RELEASE_MARKET_DATA_API_URL`

The optional endpoint secrets let CI force preview builds to use production-like backend origins instead of whatever is configured in the Vercel Preview environment.
