# Deployment Guide

This guide explains how to deploy the Shorted application to production using GitHub Actions and Google Cloud Platform.

## Architecture Overview

```
GitHub Actions → Workload Identity Federation → GCP
                                              ↓
                                    ┌─────────────────┐
                                    │ Cloud Run       │
                                    ├─────────────────┤
                                    │ • Shorts API    │
                                    │ • Market Data   │
                                    └─────────────────┘
                                              ↓
                                    ┌─────────────────┐
                                    │ Vercel          │
                                    ├─────────────────┤
                                    │ • Next.js App   │
                                    └─────────────────┘
```

## Prerequisites

1. **GCP Project** with billing enabled
2. **GitHub Repository** with Actions enabled
3. **Vercel Account** for frontend hosting
4. **Supabase Project** for PostgreSQL database

## Initial Setup

### 1. Set up Workload Identity Federation

This enables secure, keyless authentication from GitHub Actions to GCP.

```bash
# Run the setup script
./scripts/setup-workload-identity.sh

# Or use Terraform
cd terraform
terraform init
terraform apply -var="project_id=YOUR_PROJECT_ID"
```

This creates:

- Workload Identity Pool and Provider
- Service Account with necessary permissions
- Artifact Registry for Docker images

### 2. Configure GitHub Secrets

Add these secrets to your GitHub repository:

| Secret               | Description                  | Example                                                                                     |
| -------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `GCP_PROJECT_ID`     | Your GCP project ID          | `shorted-prod-123456`                                                                       |
| `WIP_PROVIDER`       | Workload Identity Provider   | `projects/123/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `SA_EMAIL`           | Service Account email        | `github-actions-sa@project.iam.gserviceaccount.com`                                         |
| `DATABASE_URL`       | PostgreSQL connection string | `postgresql://user:pass@host/db`                                                            |
| `SUPABASE_URL`       | Supabase project URL         | `https://xxx.supabase.co`                                                                   |
| `SUPABASE_ANON_KEY`  | Supabase anonymous key       | `eyJxxx...`                                                                                 |
| `VERCEL_TOKEN`       | Vercel deployment token      | `xxx`                                                                                       |
| `VERCEL_ORG_ID`      | Vercel organization ID       | `team_xxx`                                                                                  |
| `VERCEL_PROJECT_ID`  | Vercel project ID            | `prj_xxx`                                                                                   |
| `NEXTAUTH_SECRET`    | NextAuth.js secret           | Random string                                                                               |
| `ALGOLIA_APP_ID`     | Algolia Application ID       | `1BWAPWSTDD`                                                                                |
| `ALGOLIA_SEARCH_KEY` | Algolia Search-only API Key  | `0e5adba5fd8aa4b3848255a39c1287ef`                                                          |

### 3. Set up Vercel Project

```bash
# Install Vercel CLI
npm i -g vercel

# Link your project
cd web
vercel link

# Get project and org IDs
vercel project ls
```

## Deployment Process

### Automatic Deployment

Deployments happen automatically when you push to the `main` branch:

1. **Tests Run** - Unit and E2E tests
2. **Docker Build** - Services are containerized
3. **Push to Registry** - Images pushed to Artifact Registry
4. **Deploy to Cloud Run** - Services deployed
5. **Deploy Frontend** - Next.js app deployed to Vercel
6. **Smoke Tests** - Health checks on all services

### Manual Deployment

You can also trigger deployment manually:

```bash
# From GitHub UI
# Go to Actions → Build and Deploy → Run workflow

# Or use GitHub CLI
gh workflow run deploy.yml
```

## Service Configuration

### Cloud Run Services

#### Shorts Service

- **Port**: 9091
- **Memory**: 512Mi
- **CPU**: 1
- **Min Instances**: 1
- **Max Instances**: 10
- **URL**: `https://shorts-service-xxx.a.run.app`

#### Market Data Service

- **Port**: 8090
- **Memory**: 512Mi
- **CPU**: 1
- **Min Instances**: 1
- **Max Instances**: 10
- **URL**: `https://market-data-service-xxx.a.run.app`

### Environment Variables

#### Backend Services

```env
DATABASE_URL=postgresql://...
ENVIRONMENT=production
ALGOLIA_APP_ID=1BWAPWSTDD
ALGOLIA_SEARCH_KEY=0e5adba5fd8aa4b3848255a39c1287ef
ALGOLIA_INDEX=stocks
```

#### Setting up Algolia Secrets

Run the setup script to configure Algolia secrets in GCP Secret Manager:

```bash
./scripts/setup-algolia-secrets.sh
```

This will:

1. Create `ALGOLIA_APP_ID` and `ALGOLIA_SEARCH_KEY` secrets in both dev and prod projects
2. Grant the shorts service account access to these secrets

#### Frontend (Vercel)

```env
NEXT_PUBLIC_API_URL=https://shorts-service-xxx.a.run.app
NEXT_PUBLIC_MARKET_DATA_URL=https://market-data-service-xxx.a.run.app
DATABASE_URL=postgresql://...
NEXTAUTH_URL=https://shorted.com.au
NEXTAUTH_SECRET=...
```

## E2E Testing in CI

### Authenticated Tests

The CI pipeline runs authenticated E2E tests using a static test user. This is enabled by:

1. **ALLOW_E2E_AUTH=true** - Environment variable on Vercel preview
2. **Test User Credentials** - Static test account for Playwright

The test user is defined in `web/src/server/auth.ts` and only works in non-production:

```typescript
// E2E Test User - only enabled in non-production
const E2E_TEST_USER = {
  email: "e2e-test@shorted.com.au",
  password: "E2ETestPassword123!",
};
```

### CI Jobs

| Job                      | Description              | Depends On              |
| ------------------------ | ------------------------ | ----------------------- |
| `test-e2e-smoke`         | Public page tests        | `deploy-vercel-preview` |
| `test-e2e-authenticated` | Authenticated user flows | `deploy-vercel-preview` |

### Running Locally

```bash
# Run all tests with auth
cd web
RUN_AUTH_TESTS=1 npx playwright test --project=setup --project=chromium-authenticated

# Run just auth setup
npx playwright test --project=setup

# Run just smoke tests (no auth)
npx playwright test e2e/smoke.spec.ts --project=chromium
```

### Test Files

| File Pattern              | Description                           |
| ------------------------- | ------------------------------------- |
| `*.authenticated.spec.ts` | Tests that require login              |
| `*.spec.ts`               | Regular tests (run with/without auth) |
| `auth.setup.ts`           | Authentication setup (saves session)  |

## Monitoring

### Health Checks

All services expose health endpoints:

```bash
# Shorts Service
curl https://shorts-service-xxx.a.run.app/health

# Market Data Service
curl https://market-data-service-xxx.a.run.app/health
```

### Logs

View logs in GCP Console:

```bash
# Shorts Service logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=shorts-service" --limit 50

# Market Data Service logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=market-data-service" --limit 50
```

### Metrics

Monitor in GCP Console:

- Cloud Run → Services → [Service Name] → Metrics
- Key metrics: Request count, latency, error rate

## Rollback

### Rollback Cloud Run Service

```bash
# List revisions
gcloud run revisions list --service shorts-service --region australia-southeast2

# Rollback to previous revision
gcloud run services update-traffic shorts-service \
  --to-revisions PREVIOUS_REVISION=100 \
  --region australia-southeast2
```

### Rollback Vercel Deployment

```bash
# List deployments
vercel list

# Rollback
vercel rollback [deployment-url]
```

## Troubleshooting

### Build Failures

1. Check GitHub Actions logs
2. Verify all secrets are set correctly
3. Check Dockerfile syntax

### Deployment Failures

1. Check service logs:

```bash
gcloud run services logs read [service-name] --region australia-southeast2
```

2. Verify IAM permissions:

```bash
gcloud projects get-iam-policy [project-id]
```

3. Check Cloud Run service status:

```bash
gcloud run services describe [service-name] --region australia-southeast2
```

### Connection Issues

1. Verify Cloud Run services are publicly accessible
2. Check CORS configuration
3. Verify environment variables in Vercel

## Cost Optimization

### Cloud Run

- Use minimum instances = 0 for dev/staging
- Set appropriate CPU/memory limits
- Enable CPU throttling when idle

### Artifact Registry

- Set up cleanup policies for old images
- Use multi-stage Docker builds to reduce image size

### Monitoring

- Set up budget alerts in GCP
- Monitor usage in Cloud Console

## Security Best Practices

1. **Never commit secrets** - Use GitHub Secrets
2. **Use Workload Identity** - No service account keys
3. **Enable Cloud Run authentication** for internal services
4. **Set up Cloud Armor** for DDoS protection
5. **Enable VPC Service Controls** for network security
6. **Regular dependency updates** - Dependabot enabled
7. **Security scanning** - Container scanning in Artifact Registry

## Disaster Recovery

### Backup Strategy

1. **Database**: Supabase automatic backups (daily)
2. **Code**: GitHub repository
3. **Docker Images**: Artifact Registry retention
4. **Configuration**: Infrastructure as Code (Terraform)

### Recovery Process

1. Restore database from Supabase backup
2. Redeploy services from GitHub
3. Verify all environment variables
4. Run smoke tests

## Support

For deployment issues:

1. Check GitHub Actions logs
2. Review GCP Console logs
3. Create an issue with `deployment` label
