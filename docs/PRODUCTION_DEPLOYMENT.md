# Production Deployment Guide

## Overview

This guide covers the process for deploying Shorted.com.au to production using the CI/CD pipeline.

## Deployment Triggers

| Trigger | Environment | Action |
|---------|-------------|--------|
| `pull_request` | dev | Preview deployment (auto-cleanup on close) |
| `push` to `main` | dev | Full deployment to dev |
| `release` (published) | **prod** | Full deployment to production |
| `workflow_dispatch` | dev/prod | Manual trigger with options |

## Pre-Deployment Checklist

### 1. GitHub Secrets Configuration

Ensure these secrets are configured in GitHub repository settings:

#### Common Secrets (Both Environments)
| Secret | Description | Required |
|--------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | ✅ |
| `NEXTAUTH_SECRET` | NextAuth.js encryption secret | ✅ |
| `AUTH_GOOGLE_ID` | Google OAuth client ID | ✅ |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret | ✅ |
| `AUTH_FIREBASE_PROJECT_ID` | Firebase project ID | ✅ |
| `AUTH_FIREBASE_CLIENT_EMAIL` | Firebase service account email | ✅ |
| `AUTH_FIREBASE_PRIVATE_KEY` | Firebase private key | ✅ |
| `ALGOLIA_APP_ID` | Algolia application ID | ✅ |
| `ALGOLIA_SEARCH_KEY` | Algolia search API key | ✅ |

#### Deployment Secrets
| Secret | Description | Required |
|--------|-------------|----------|
| `VERCEL_TOKEN` | Vercel deployment token | ✅ |
| `OPENAI_API_KEY` | OpenAI API key for enrichment | ✅ |
| `INTERNAL_SERVICE_SECRET` | Service-to-service auth | ✅ |

#### Stripe Secrets (Payment Processing)
| Secret | Description | Required |
|--------|-------------|----------|
| `STRIPE_SECRET_KEY` | Stripe API secret key | ✅ |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key | ✅ |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | ✅ |
| `STRIPE_PRO_PRICE_ID` | Stripe Pro plan price ID | ✅ |
| `STRIPE_API_ACCESS_PRICE_ID` | Dedicated API access plan price ID | ⚪ Optional |

#### Firebase Browser Secrets (Production)
| Secret | Description | Required |
|--------|-------------|----------|
| `NEXT_PUBLIC_FIREBASE_API_KEY_PROD` | Firebase browser API key for production auth | ✅ |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN_PROD` | Firebase auth domain | ✅ |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID_PROD` | Firebase browser project ID | ✅ |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET_PROD` | Firebase storage bucket | ✅ |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID_PROD` | Firebase messaging sender ID | ✅ |
| `NEXT_PUBLIC_FIREBASE_APP_ID_PROD` | Firebase app ID | ✅ |

Production release validation runs `npm --prefix web run firebase:preflight` before build and runs the Firebase Google sign-in bootstrap during release smoke. These gates catch malformed public config, including escaped newline API keys that produce `API_KEY_INVALID` from `identitytoolkit.googleapis.com`. See `docs/FIREBASE_AUTH_VALIDATION.md`.

### 2. GCP Project Setup

Production GCP project: `rosy-clover-477102-t5`

Required APIs (enabled by Terraform):
- Cloud Run
- Cloud Scheduler
- Artifact Registry
- Secret Manager
- Pub/Sub
- IAM

### 3. Workload Identity Federation

Production service account: `github-actions-sa@rosy-clover-477102-t5.iam.gserviceaccount.com`

Workload Identity Provider: `projects/334313144667/locations/global/workloadIdentityPools/github-pool/providers/github-provider`

## Soft Deployment (Dry Run)

To preview changes before applying:

1. Go to **Actions** → **🚀 Deploy Infrastructure**
2. Click **Run workflow**
3. Select:
   - Branch: `main` (or your release branch)
   - Environment: `prod`
   - **Plan only: ✅ checked**
4. Review the Terraform plan in the job summary

This will:
- ✅ Build and push Docker images
- ✅ Run Terraform plan
- ❌ NOT apply any changes

## Production Deployment

### Option 1: GitHub Release (Recommended)

```bash
# Create and push a release tag
git tag v1.0.0
git push origin v1.0.0

# Then create a Release in GitHub UI:
# 1. Go to Releases → Create a new release
# 2. Choose tag: v1.0.0
# 3. Add release notes
# 4. Publish release
```

### Option 2: Manual Workflow Dispatch

1. Go to **Actions** → **🚀 Deploy Infrastructure**
2. Click **Run workflow**
3. Select:
   - Branch: `main`
   - Environment: `prod`
   - Plan only: ❌ unchecked
4. Confirm and run

## Post-Deployment Verification

Before checking service health manually, confirm the release gates passed:

```bash
npm --prefix web run firebase:preflight
npm --prefix web run stripe:preflight
set -a; source .env; set +a
export CLOUDFLARE_TESTING_BYPASS_SECRET="${CLOUDFLARE_TESTING_BYPASS_SECRET:-$TF_VAR_rate_limit_testing_bypass_secret}"
BASE_URL=https://shorted.com.au \
RELEASE_API_BASE_URL=https://api.shorted.com.au \
CLOUDFLARE_TESTING_BYPASS_SECRET="$CLOUDFLARE_TESTING_BYPASS_SECRET" \
node web/e2e/release-smoke-ci.mjs
```

The smoke run includes the Firebase Google sign-in bootstrap check and must fail on `API_KEY_INVALID`, escaped newline Firebase keys, Identity Toolkit errors, or failure to create a Google auth URI through the browser flow or direct Identity Toolkit probe.

### 1. Check Service Status

```bash
# List all services
gcloud run services list --project rosy-clover-477102-t5 --region australia-southeast2

# Check specific service
gcloud run services describe shorts --project rosy-clover-477102-t5 --region australia-southeast2
```

### 2. Test Endpoints

```bash
# Shorts API health check
curl https://shorts-HASH.australia-southeast2.run.app/health

# Test search (replace shorts-HASH with the run.app host from
# gcloud run services describe shorts --format='value(status.url)')
curl -X POST https://shorts-HASH.australia-southeast2.run.app/shorts.v1alpha1.MarketService/GetTopShorts \
  -A "shorted-ops-check/1.0" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1}'
```

Expect HTTP 200 and a body containing `"timeSeries"`. The `-A` is needed: the API's user-agent filter refuses curl's default User-Agent, and any script's, with HTTP 403 `permission_denied` ("automated access detected") on every revision, good or bad. That is the filter, not a broken revision.

### 3. Verify Scheduled Jobs

```bash
gcloud scheduler jobs list --project rosy-clover-477102-t5 --location australia-southeast1
```

## Rollback Procedure

The live API is the Cloud Run service `shorts` in `australia-southeast2`. The Terraform module that defines it is `terraform/modules/shorts-api`, which is why that directory name appears here. Rolling back is a traffic shift to an earlier revision of that service.

Before you shift, know what is still coming. Every push to `main` deploys, and each deploy's `terraform-apply` job sets 100% of traffic back to the newest revision, so it undoes a shift. Two traps:

- A deploy that is queued is not in the Cuttlefish runs list. The workflow's concurrency group holds one run at a time (`deploy-refs/heads/main`), and a push that lands while a deploy runs only starts once that whole run ends, after `deploy-vercel-prod`, not after its `terraform-apply`.
- So "no `terraform-apply` running" is not enough. Compare `main`'s head with the build of the newest revision:

  ```bash
  git ls-remote https://github.com/castlemilk/shorted.com.au refs/heads/main | cut -c1-8   # main's head
  ```

  The newest revision's `SERVICE_VERSION` (read as in step 1) is `main-<first 8 of the sha>` after a push deploy and `manual-<full sha>` after a dispatched one (`cuttle gha dispatch`). Take the sha after the prefix and compare its first 8 characters with `main`'s head. While they differ, a deploy is still coming, running or queued, unless the deploy of `main`'s head has already ended without a `terraform-apply`: red tests or a failed build skip that job, so check that deploy's runs. When they match and no `gha-terraform-deploy-*` run is RUNNING, the shift holds, but only until the next push to `main` (step 3).

If users are affected now, shift now anyway, and keep re-checking as step 3 says.

### 1. Find the revision to return to

```bash
gcloud run revisions list --service shorts \
  --project rosy-clover-477102-t5 --region australia-southeast2
```

Revisions are named `shorts-NNNNN-xxx`, newest first. The revision marked `ACTIVE yes` is the one serving now. `revisions list` does not show traffic percentages; `gcloud run services describe shorts --project rosy-clover-477102-t5 --region australia-southeast2 --format='value(status.traffic)'` does.

Choose by change, not by position. Every deploy of `main` creates a revision, whether or not the API changed (16 in 19 hours on 2026-11-05/06), and revisions are cumulative: once any later deploy lands, "the revision before the active one" contains the bad change too. Find the commit that introduced the problem, then take the newest revision whose build does not contain it. In a checkout of this repository:

```bash
git fetch -q origin main
# For each candidate revision, newest first: SHA is the sha after "main-" or "manual-"
# in its SERVICE_VERSION (below).
git merge-base --is-ancestor <bad commit> "$SHA"; case $? in
  0) echo "contains the bad change" ;;
  1) echo "safe" ;;
  *) echo "git could not answer: fetch again and check both shas" ;;
esac
```

The first revision that prints `safe` is the one to return to. Fetch first and never read an error as `safe`: git exits 128 for a sha it does not have, and a clone without the newest commits lacks exactly the newest revisions, the ones most likely to carry the bad change.

If the bad commit is unknown, the suspect is the newest revision whose `DEPLOYED` time is before the errors began: it was serving when they started. Return to the revision before the suspect. If the errors began long after the suspect was deployed, a code change may not be the cause: read the logs and the database status before shifting.

To see which build a revision runs, read its `SERVICE_VERSION` environment variable. Terraform sets it to the image tag from this change onward:

```bash
gcloud run revisions describe REVISION \
  --project rosy-clover-477102-t5 --region australia-southeast2 \
  --format=json | jq -r '.spec.containers[0].env[] | select(.name=="SERVICE_VERSION") | .value'
```

Revisions created before that change have no `SERVICE_VERSION`. For those, `--format='value(spec.containers[0].image)'` prints a digest, not a tag. Map it to its tag with `gcloud artifacts docker images list australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/shorts --include-tags --filter='version~^sha256:<digest>'`.

### 2. Shift 100% of traffic to that revision

```bash
gcloud run services update-traffic shorts \
  --project rosy-clover-477102-t5 \
  --region australia-southeast2 \
  --to-revisions=REVISION=100
```

A revision is immutable and carries its own image, memory and environment, so the shift restores all of them. A revision from before the 1Gi change has 256Mi and no `GOMEMLIMIT`, and it brings back the memory-limit kills for as long as the rollback holds.

Then confirm the build on the `run.app` host, which is not cached at the edge (`gcloud run services describe shorts --project rosy-clover-477102-t5 --region australia-southeast2 --format='value(status.url)'`):

```bash
curl -sI https://<run.app host>/health | grep -i x-shorted-build
```

The value should equal the `SERVICE_VERSION` you read from the revision. A revision with no `SERVICE_VERSION` predates the build header (they arrived together) and answers with no `X-Shorted-Build` at all: for those, confirm with `status.traffic` (above) instead. Either check confirms which revision is serving, not that the bad code is gone: only choosing the revision by change (step 1) does that. Then run the Connect call in "Post-Deployment Verification". Keep watching the uptime alerts until both checks pass.

### 3. The next deploy undoes the shift

A traffic shift is not a code change. Terraform still declares `shorts` to route 100% to the latest revision, and every push to `main` runs `terraform-deploy`, which applies the newest image again. A rollback therefore holds only until the next deploy. Before the next push to `main`, do one of the following:

- Ship the fix: merge the code fix to `main` and let it deploy.
- Revert the bad change on `main` (a `git revert` of the offending commit), so the next deploy builds the previous behaviour.

Until one of these lands, `terraform plan` shows drift on the traffic. That is expected during a rollback.

A shift also does not survive a deploy that is already running or queued. Its `terraform-apply` job sets traffic back to the newest revision, and the shift is then gone without any sign in the rollback itself. After each deploy's `terraform-apply` job finishes, re-check `gcloud run services describe shorts --project rosy-clover-477102-t5 --region australia-southeast2 --format='value(status.traffic)'`. If traffic has moved back to the newest revision, first check whether that revision carries the fix or the revert: run the step 1 test with the fix or revert commit in place of the bad commit, against the newest revision's sha (`contains` means it carries it). The bad commit's test cannot tell you this, because a revert's build still contains the bad commit. If it carries the fix, stop: the fix is serving, so run "Post-Deployment Verification". If it does not, shift again to the revision you chose in step 1.

Keep re-checking after every deploy until the fix or the revert is serving, or hold merges to `main` until then. A match between `main`'s head and the newest revision says only that the shift holds for now: the next push to `main`, for any change, undoes it.

## Monitoring

- **Cloud Run Console**: https://console.cloud.google.com/run?project=rosy-clover-477102-t5
- **Logs**: https://console.cloud.google.com/logs?project=rosy-clover-477102-t5
- **Vercel Dashboard**: https://vercel.com/team_xE5DMN3hIo8aPqyHNkBybg8r/shorted-com-au

## Uptime checks

Two checks watch the API from outside the cluster, so they still report when the cluster or the deploy tooling is down. They are defined in `terraform/modules/shorts-api/uptime.tf`:

- `api.shorted.com.au`, a real Connect call (`GetTopShorts`, `{"limit":1}`), every 5 minutes. A response passes when it is HTTP 200 and its body contains `"timeSeries"` (protojson omits an empty list, so a 200 without it means there is no data).
- The Cloud Run `/health` on the `run.app` host, every minute. It passes on HTTP 200 and `OK`.

Each has an alert policy. It fires when the check fails from two or more checker regions for 5 minutes. Both notify the job-monitoring email channel, which exists only when `ALERT_RECIPIENT_EMAIL` is set. Check results are under Cloud Monitoring, Uptime checks.

### When the public check fails

1. Open the check's latest results by region. The first results appear about 10 minutes after a deploy.
2. Repeat the request the way the checker sends it:

   ```bash
   curl -i -A 'GoogleStackdriverMonitoring-UptimeChecks(https://cloud.google.com/monitoring)' \
     -X POST https://api.shorted.com.au/shorts.v1alpha1.MarketService/GetTopShorts \
     -H 'Content-Type: application/json' -d '{"limit":1}'
   ```

3. Read the answer:
   Read `X-Shorted-Cache` before `X-Shorted-Build`. The edge worker rebuilds the headers of every copy it serves, so a copy never carries `X-Shorted-Build`, whatever the API answered when it was cached:
   - `X-Shorted-Cache: HOT`, `HIT` or `KV`: an edge copy. It proves nothing about the origin. A cached `{}` is the API's empty answer, so check `mv_top_shorts` and the fallback query. Copies live for their TTL, so a check that fails once they expire has reached the origin.
   - `X-Shorted-Cache: BYPASS` or `MISS` with no `X-Shorted-Build`: Cloud Run's front end answered, for a crash, a memory-limit kill or no instance available. Read the `shorts` service's logs. The exception is a rollback to a revision with no `SERVICE_VERSION`: it predates the header and never sends it, so check `status.traffic` first.
   - `X-Shorted-Build` present: the app answered. A 5xx is an app error, and the Cloud Run logs and the database are next. A `403` with JSON `permission_denied` ("automated access detected") is the API's user-agent filter, `services/pkg/ratelimit/useragent.go`. The checker's User-Agent must stay allowed there, and `TestUptimeCheckerUserAgentPasses` pins it. A `429` with an `X-RateLimit-Detail` header is the app's per-minute limiter.
   - A `429` with `X-RateLimit-Bucket` is the edge worker's bucket (anonymous callers get 10 requests per 10 seconds per IP).
   - A `524`, or a `cf-mitigated` header, or an HTML "Just a moment" page with no `X-Shorted-Cache`: Cloudflare answered. A `524` is Cloudflare's origin timeout; a challenge or zone rule is the other case.
4. Repeat the same `GetTopShorts` call against the `run.app` host, with the same `-A` User-Agent. If it fails there too, the service or the database is the problem: read the `shorts` service's logs and the Supabase status. If it passes there and fails through `api.shorted.com.au`, the problem is on the Cloudflare path. `/health` alone does not decide it, because it touches neither the handlers nor the database.

Do not add a WAF bypass in response to a challenge without a reviewed change to the Cloudflare Terraform. If Cloudflare challenges the checkers, the options in order are: keep the check on `/health` only, which leaves the public path unmonitored; ask for a Cloudflare allowlist scoped to the checkers' published source ranges and this one path; or move the check to a path the edge does not challenge.

## Troubleshooting

### Deployment Failed

1. Check GitHub Actions logs
2. Review Terraform plan output
3. Verify all secrets are configured
4. Check GCP IAM permissions

### Service Not Responding

1. Check Cloud Run logs
2. Verify environment variables
3. Test database connectivity
4. Check service account permissions

### Scheduled Jobs Not Running

1. Verify Cloud Scheduler job status
2. Check job execution history
3. Review Cloud Run job logs
