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
gcloud run services describe shorts-api --project rosy-clover-477102-t5 --region australia-southeast2
```

### 2. Test Endpoints

```bash
# Shorts API health check
curl https://shorts-api-HASH.australia-southeast2.run.app/health

# Test search
curl -X POST https://shorts-api-HASH.australia-southeast2.run.app/v1/topShorts \
  -H "Content-Type: application/json" \
  -d '{"limit": 5}'
```

### 3. Verify Scheduled Jobs

```bash
gcloud scheduler jobs list --project rosy-clover-477102-t5 --location australia-southeast1
```

## Rollback Procedure

### Quick Rollback (Traffic Shift)

```bash
# Route traffic back to previous revision
gcloud run services update-traffic shorts-api \
  --project rosy-clover-477102-t5 \
  --region australia-southeast2 \
  --to-revisions=PREVIOUS_REVISION=100
```

### Full Rollback (Redeploy Previous Tag)

```bash
# Trigger workflow dispatch with previous release tag
# Or create a new release from the previous stable commit
```

## Monitoring

- **Cloud Run Console**: https://console.cloud.google.com/run?project=rosy-clover-477102-t5
- **Logs**: https://console.cloud.google.com/logs?project=rosy-clover-477102-t5
- **Vercel Dashboard**: https://vercel.com/team_xE5DMN3hIo8aPqyHNkBybg8r/shorted-com-au

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
