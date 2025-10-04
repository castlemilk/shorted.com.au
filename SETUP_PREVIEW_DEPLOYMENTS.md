# Setting Up Preview Deployments for PRs

This guide will help you configure your GitHub repository to automatically deploy preview environments for every pull request, including backend services on Google Cloud Run and frontend on Vercel.

## Current Status

❌ **Preview deployments are currently not fully configured** because the required GitHub secrets are missing.

## What You'll Get

Once configured, every PR will automatically:

1. 🚀 Deploy backend services (Shorts API & Market Data API) to Google Cloud Run with PR-specific URLs
2. 🌐 Deploy frontend to Vercel with preview URL
3. 🔗 Connect the preview frontend to the PR-specific backend
4. 🧪 Run E2E tests against the deployed preview environment
5. 💬 Comment on the PR with deployment URLs and test results
6. 🧹 Clean up all resources when the PR is closed

## Prerequisites

Before you begin, make sure you have:

- ✅ Google Cloud Project with billing enabled
- ✅ Vercel account connected to your GitHub repository
- ✅ `gh` CLI installed and authenticated (`brew install gh && gh auth login`)
- ✅ `gcloud` CLI installed and authenticated ([Install guide](https://cloud.google.com/sdk/docs/install))
- ✅ Admin access to your GitHub repository
- ✅ Admin access to your GCP project

## Step 1: Set Up Google Cloud Platform

### 1a. Enable Required APIs

```bash
# Set your project ID
export GCP_PROJECT_ID="your-project-id-here"

gcloud config set project $GCP_PROJECT_ID

# Enable required services
gcloud services enable \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com
```

### 1b. Run the Workload Identity Federation Setup Script

This creates a secure, keyless authentication method for GitHub Actions:

```bash
cd /Users/benebsworth/projects/shorted

# Make the script executable
chmod +x scripts/setup-workload-identity.sh

# Run the setup (will prompt for project ID)
./scripts/setup-workload-identity.sh
```

This script will:

- Create a Workload Identity Pool for GitHub Actions
- Create a Service Account with necessary permissions
- Set up trust relationship between GitHub and GCP
- Create an Artifact Registry repository for Docker images

**Save the output values** - you'll need them in the next step!

## Step 2: Configure GitHub Secrets

### 2a. Get Your Vercel Credentials

```bash
# Install Vercel CLI if you haven't already
npm install -g vercel

# Login to Vercel
vercel login

# Link your project (run from the web directory)
cd web
vercel link

# Get your Vercel Token
# Go to: https://vercel.com/account/tokens
# Create a new token and save it

# Get your Vercel Org ID and Project ID
# They're in the .vercel/project.json file after running `vercel link`
cat .vercel/project.json
```

### 2b. Set GitHub Secrets

You can use the automated script:

```bash
cd /Users/benebsworth/projects/shorted
./scripts/setup-github-secrets.sh
```

Or set them manually using the GitHub CLI:

```bash
# GCP Secrets (from Step 1 output)
gh secret set GCP_PROJECT_ID --body="your-gcp-project-id"
gh secret set WIP_PROVIDER --body="projects/YOUR_PROJECT_ID/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
gh secret set SA_EMAIL --body="github-actions-sa@your-project-id.iam.gserviceaccount.com"

# Vercel Secrets (from Step 2a)
gh secret set VERCEL_TOKEN --body="your-vercel-token"
gh secret set VERCEL_ORG_ID --body="your-org-id"
gh secret set VERCEL_PROJECT_ID --body="your-project-id"

# Database URL (your Supabase or PostgreSQL connection string)
gh secret set DATABASE_URL --body="postgresql://user:password@host:port/database"

# NextAuth secrets (generate a random string for NEXTAUTH_SECRET)
gh secret set NEXTAUTH_SECRET --body="$(openssl rand -base64 32)"

# Firebase/Auth secrets (if you have them)
gh secret set AUTH_FIREBASE_PROJECT_ID --body="your-firebase-project-id"
gh secret set AUTH_FIREBASE_CLIENT_EMAIL --body="your-firebase-client-email"
gh secret set AUTH_FIREBASE_PRIVATE_KEY --body="your-firebase-private-key"
gh secret set AUTH_GOOGLE_ID --body="your-google-oauth-client-id"
gh secret set AUTH_GOOGLE_SECRET --body="your-google-oauth-client-secret"
```

### 2c. Verify Secrets Are Set

```bash
gh secret list
```

You should see all the secrets listed above.

## Step 3: Test the Setup

### 3a. Trigger a Preview Deployment

You can test the setup in two ways:

**Option 1: Push to your existing PR**

```bash
git commit --allow-empty -m "Test preview deployment"
git push
```

**Option 2: Run the workflow manually**

```bash
gh workflow run "Preview and Test"
```

### 3b. Monitor the Deployment

```bash
# Watch the workflow run
gh run watch

# Or view in your browser
gh run list --workflow="Preview and Test" --limit 1
gh run view  # Opens the most recent run
```

### 3c. Check the PR Comment

Once the workflow completes, you should see a comment on your PR with:

- ✅ Frontend preview URL
- ✅ Backend service URLs (PR-specific)
- 🧪 E2E test results

## Step 4: Verify Everything Works

1. **Check the PR comment** - it should show all deployed URLs
2. **Visit the preview URL** - make sure the frontend loads
3. **Test the backend** - visit the `/health` endpoint on the Shorts API
4. **Review the E2E test results** - check if tests passed

## Troubleshooting

### Missing Secrets Error

If you see warnings about missing secrets in the workflow logs:

```bash
# Check which secrets are missing
gh secret list

# Add any missing secrets using the commands from Step 2b
```

### GCP Authentication Errors

If you see "permission denied" or authentication errors:

```bash
# Verify the Workload Identity Federation setup
gcloud iam workload-identity-pools list --location=global

# Check the service account has the right roles
gcloud projects get-iam-policy $GCP_PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:github-actions-sa@*"
```

### Vercel Deployment Fails

If Vercel deployment fails:

```bash
# Verify your Vercel credentials
vercel whoami

# Check your tokens
# Go to: https://vercel.com/account/tokens

# Re-link your project
cd web
vercel link --yes
```

### E2E Tests Fail

E2E test failures are expected if:

- The preview deployment isn't ready yet (it takes 2-3 minutes)
- Backend services aren't fully initialized
- Environment variables aren't set correctly

Check the test logs for specific errors.

## Cost Considerations

Preview deployments will incur some costs:

- **Google Cloud Run**: ~$0.10-0.50 per PR (with auto-scaling to zero)
- **Vercel**: Included in free tier for most use cases
- **Artifact Registry**: ~$0.10/GB/month for Docker images

**Cost Optimization Tips**:

- Preview services auto-scale to zero when not in use
- Services are automatically deleted when PR is closed
- Docker images are tagged per-PR and cleaned up

## Cleanup

Preview environments are automatically cleaned up when you close or merge a PR. The cleanup workflow will:

- Delete Cloud Run services
- Remove Docker images from Artifact Registry
- Remove Vercel deployment aliases

## Next Steps

Once everything is working:

1. **Document your workflow** - Add this guide to your team's onboarding docs
2. **Configure branch protection** - Require E2E tests to pass before merging
3. **Monitor costs** - Set up billing alerts in GCP
4. **Optimize build times** - Use Docker layer caching for faster builds

## Getting Help

If you run into issues:

1. Check the [GitHub Actions logs](https://github.com/castlemilk/shorted.com.au/actions)
2. Review the [Preview Deployments documentation](./docs/PREVIEW_DEPLOYMENTS.md)
3. Check the [Deployment Guide](./DEPLOYMENT.md)
4. Open an issue in the repository

## Summary Checklist

- [ ] GCP project with billing enabled
- [ ] Required GCP APIs enabled
- [ ] Workload Identity Federation configured
- [ ] Artifact Registry repository created
- [ ] All GitHub secrets configured
- [ ] Vercel project linked
- [ ] Test PR created and deployment successful
- [ ] E2E tests running against preview

Once all checkboxes are complete, your preview deployment system is fully operational! 🎉
