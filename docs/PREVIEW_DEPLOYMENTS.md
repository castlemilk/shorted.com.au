# Preview Deployments Setup Guide

This guide walks through setting up preview deployments for pull requests.

## Overview

When you create a pull request, the system automatically:
1. Deploys backend services to Google Cloud Run with `pr-{number}` naming
2. Deploys frontend to Vercel with preview URLs
3. Connects the preview frontend to preview backend services
4. Cleans up resources when the PR is closed

## Prerequisites

- Google Cloud Project with billing enabled
- GitHub repository with Actions enabled
- Vercel account connected to your GitHub repository
- `gh` CLI installed and authenticated
- `gcloud` CLI installed and authenticated
- Terraform installed (for initial setup)

## Setup Steps

### 1. Enable Required GCP APIs

```bash
gcloud services enable \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com
```

### 2. Set Up Workload Identity Federation

```bash
cd terraform
terraform init
terraform plan -var="project_id=YOUR_PROJECT_ID"
terraform apply -var="project_id=YOUR_PROJECT_ID"
```

This creates:
- Workload Identity Pool for GitHub Actions
- Service Account with necessary permissions
- Trust relationship between GitHub and GCP

### 3. Configure GitHub Secrets

Run the setup script:

```bash
./scripts/setup-github-secrets.sh
```

Or manually set these secrets in your GitHub repository:
- `GCP_PROJECT_ID`: Your GCP project ID
- `WIP_PROVIDER`: `projects/{project}/locations/global/workloadIdentityPools/github-pool/providers/github-provider`
- `SA_EMAIL`: `github-actions@{project}.iam.gserviceaccount.com`
- `SUPABASE_URL`: Your Supabase project URL (optional)
- `SUPABASE_ANON_KEY`: Your Supabase anon key (optional)

### 4. Configure Vercel

Vercel should automatically detect pull requests if your repository is connected. The preview deployment workflow will pass the backend URLs as environment variables.

### 5. Test the Setup

1. Create a test branch:
   ```bash
   git checkout -b test/preview-deployment
   ```

2. Make a small change and commit:
   ```bash
   echo "# Test" >> README.md
   git add README.md
   git commit -m "Test preview deployment"
   ```

3. Push and create a PR:
   ```bash
   git push -u origin test/preview-deployment
   gh pr create --title "Test preview deployment" --body "Testing preview deployments"
   ```

4. Check the deployment:
   - Go to the GitHub Actions tab
   - Look for "Preview Deployment" workflow
   - Check the Vercel preview URL in the PR comments
   - Verify the preview connects to the preview backend

5. Clean up:
   - Close the PR
   - Check that the "Preview Cleanup" workflow runs
   - Verify Cloud Run services are deleted

## Environment Variables

The preview deployment automatically sets these environment variables in Vercel:

- `NEXT_PUBLIC_API_URL`: Points to the preview shorts service
- `NEXT_PUBLIC_MARKET_DATA_URL`: Points to the preview market data service
- `NEXT_PUBLIC_ENVIRONMENT`: Set to "preview"
- `NEXT_PUBLIC_PR_NUMBER`: The PR number

## Troubleshooting

### Authentication Errors

If you see "workload_identity_provider" errors:
1. Check that GitHub secrets are set: `gh secret list`
2. Verify the Workload Identity Federation is configured in GCP
3. Check the service account has the correct permissions

### Build Failures

If the Docker build fails:
1. Check the Dockerfile syntax
2. Verify all dependencies are specified
3. Check the build logs for specific errors

### Connection Issues

If the preview frontend can't connect to the backend:
1. Check that environment variables are set in Vercel
2. Verify the Cloud Run services are deployed and running
3. Check that the services allow unauthenticated access
4. Review the centralized config in `web/src/app/actions/config.ts`

### Cleanup Not Working

If resources aren't cleaned up when PRs close:
1. Check the cleanup workflow ran
2. Verify the service account has delete permissions
3. Manually clean up with: `gcloud run services delete pr-{number}-shorts`

## Manual Commands

### Check deployed services:
```bash
gcloud run services list --region=australia-southeast2
```

### Check preview service logs:
```bash
gcloud run logs read pr-44-shorts --region=australia-southeast2
```

### Manually delete preview services:
```bash
gcloud run services delete pr-44-shorts --region=australia-southeast2
gcloud run services delete pr-44-market-data --region=australia-southeast2
```

## Cost Considerations

Preview deployments incur costs for:
- Cloud Run service runtime (billed per request)
- Container storage in Artifact Registry
- Network egress for API calls

To minimize costs:
- Clean up preview deployments promptly
- Use the automatic cleanup workflow
- Set resource limits in Cloud Run configurations