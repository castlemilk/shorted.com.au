# Preview Deployments Guide

This guide explains how preview deployments work for pull requests in the Shorted application.

## Overview

Every pull request automatically gets a full preview environment with:
- Dedicated Cloud Run services for backend APIs
- Vercel preview deployment for frontend
- Custom URL: `https://pr-{number}.shorted.vercel.app`
- Automatic cleanup when PR is closed

## Architecture

```
Pull Request Created/Updated
         ↓
GitHub Actions Workflow
         ↓
    ┌────────────────────────────────┐
    │ Build & Deploy Preview          │
    ├────────────────────────────────┤
    │ 1. Build Docker images          │
    │ 2. Deploy to Cloud Run (preview) │
    │ 3. Deploy to Vercel (preview)    │
    │ 4. Run smoke tests               │
    │ 5. Comment on PR with URLs       │
    └────────────────────────────────┘
         ↓
Preview Environment Ready
```

## Features

### 🚀 Automatic Deployment
- Triggers on PR open, update, or reopen
- Full stack deployment in ~5 minutes
- Parallel builds for faster deployment

### 🔗 Custom URLs
- Frontend: `https://pr-{number}.shorted.vercel.app`
- Shorts API: `https://shorts-service-pr-{number}-xxx.a.run.app`
- Market Data API: `https://market-data-service-pr-{number}-xxx.a.run.app`

### 🏷️ Environment Identification
- Yellow banner shows on preview sites
- Links back to PR number
- Shows "Preview Environment" label

### 🧹 Automatic Cleanup
- Services deleted when PR is closed
- Docker images cleaned up
- Vercel alias removed
- Zero manual cleanup required

## How It Works

### 1. Developer Creates PR

When you create or update a pull request:

```bash
git checkout -b feature/my-feature
# Make changes
git push origin feature/my-feature
# Create PR on GitHub
```

### 2. Preview Deployment Starts

GitHub Actions automatically:
1. Builds Docker images tagged with `pr-{number}`
2. Pushes to Google Artifact Registry
3. Deploys Cloud Run services with preview config
4. Deploys frontend to Vercel
5. Sets up custom domain alias

### 3. Preview Ready Notification

The bot comments on your PR with:
- Preview environment URLs
- Health check status
- Test instructions

Example comment:
```markdown
## 🚀 Preview Deployment Ready!

Your preview environment has been deployed:

| Service | URL |
|---------|-----|
| **Frontend** | https://pr-123.shorted.vercel.app |
| **Shorts API** | https://shorts-service-pr-123-xxx.a.run.app |
| **Market Data API** | https://market-data-service-pr-123-xxx.a.run.app |
```

### 4. Testing the Preview

Visit the preview URL to:
- Test your changes in isolation
- Share with reviewers
- Run E2E tests against preview
- Validate API changes

### 5. Automatic Cleanup

When the PR is closed (merged or declined):
- Cloud Run services are deleted
- Docker images are removed
- Vercel deployment is archived
- Cleanup comment posted to PR

## Configuration

### Cloud Run Preview Settings

Preview deployments use reduced resources:

```yaml
Memory: 256Mi (vs 512Mi production)
CPU: 1
Min Instances: 0 (scales to zero)
Max Instances: 2 (vs 10 production)
Environment: preview
```

### Vercel Preview Settings

```javascript
{
  "env": {
    "NEXT_PUBLIC_ENVIRONMENT": "preview",
    "NEXTAUTH_URL": "https://pr-{number}.shorted.vercel.app"
  }
}
```

### Cost Optimization

Preview environments are optimized for cost:
- **Scale to zero**: No traffic = no cost
- **Reduced resources**: Lower memory/CPU
- **Automatic cleanup**: No lingering resources
- **Shared database**: Uses same DB with preview flag

## Environment Variables

Preview deployments inherit secrets from GitHub:

| Variable | Description | Source |
|----------|-------------|--------|
| `DATABASE_URL` | PostgreSQL connection | GitHub Secret |
| `NEXTAUTH_SECRET` | Auth secret | GitHub Secret |
| `NEXT_PUBLIC_ENVIRONMENT` | Set to "preview" | Workflow |
| `NEXT_PUBLIC_API_URL` | Dynamic Cloud Run URL | Workflow |

## Debugging Preview Deployments

### Check Deployment Status

1. Go to PR → Checks tab
2. Look for "Preview Deployment" workflow
3. Click for detailed logs

### View Logs

```bash
# Cloud Run logs
gcloud run logs read --service shorts-service-pr-123 --region australia-southeast2

# Vercel logs
vercel logs pr-123.shorted.vercel.app
```

### Common Issues

#### Preview Not Deploying
- Check if workflows are enabled for the repository
- Verify PR is targeting main/develop branch
- Check GitHub Actions quota

#### Services Not Responding
- Check Cloud Run service status in GCP Console
- Verify environment variables are set
- Check service logs for errors

#### Vercel Alias Not Working
- May take 1-2 minutes to propagate
- Check Vercel dashboard for deployment status
- Verify VERCEL_TOKEN is valid

## Advanced Usage

### Testing Against Preview

Run E2E tests against preview:

```bash
# Set preview URL
export BASE_URL=https://pr-123.shorted.vercel.app

# Run tests
npm run test:e2e
```

### Manual Preview Deployment

Trigger manually from GitHub:

1. Go to Actions tab
2. Select "Preview Deployment"
3. Click "Run workflow"
4. Select PR branch

### Preview with Production Data

By default, previews use the same database. To use separate data:

1. Create preview database
2. Update `DATABASE_URL` in workflow
3. Run seed script in preview

## Best Practices

### 1. Keep PRs Focused
Smaller PRs deploy faster and are easier to review

### 2. Test Thoroughly
Use the preview to test:
- New features
- API changes
- UI updates
- Mobile responsiveness

### 3. Share Previews
Send preview URLs to:
- Designers for UI review
- Product managers for feature validation
- QA for testing

### 4. Clean Git History
Squash commits before merging to keep history clean

## Security Considerations

### Preview Isolation
- Each preview has unique URLs
- No production data access
- Separate from production services

### Access Control
- Public by default (can be restricted)
- No production secrets exposed
- Auth uses preview-specific URLs

### Data Protection
- Shared database with preview flag
- No customer data in previews
- Test data only

## Monitoring

### GitHub Deployment Status
- View all deployments: `/deployments`
- Environment-specific: `/deployments/preview-pr-{number}`

### Metrics
Track preview usage:
- Deployment frequency
- Build times
- Resource usage
- Cost per preview

## Cost Analysis

Estimated costs per preview:
- **Cloud Run**: ~$0.10/day (when active)
- **Artifact Registry**: ~$0.01/day
- **Vercel**: Free tier usually sufficient
- **Total**: <$1 per PR when active

## Troubleshooting

### Preview deployment failed
```bash
# Check workflow logs
gh run view [run-id] --log

# Retry deployment
gh workflow run preview-deploy.yml -f pr_number=123
```

### Services not starting
```bash
# Check Cloud Run status
gcloud run services describe shorts-service-pr-123 --region australia-southeast2

# Check health endpoint
curl https://shorts-service-pr-123-xxx.a.run.app/health
```

### Cleanup failed
```bash
# Manual cleanup
gcloud run services delete shorts-service-pr-123 --region australia-southeast2
gcloud artifacts docker images delete [...]/shorts:pr-123
```

## FAQ

**Q: How long do previews stay active?**
A: Until the PR is closed, then automatically cleaned up.

**Q: Can I have multiple previews?**
A: Yes, each PR gets its own preview environment.

**Q: Do previews cost money?**
A: Minimal cost due to scale-to-zero and automatic cleanup.

**Q: Can I disable previews for my PR?**
A: Add `[skip preview]` to your PR title.

**Q: How do I update my preview?**
A: Push new commits to your PR branch.

## Support

For preview deployment issues:
1. Check workflow logs
2. Review this documentation
3. Create issue with `preview-deployment` label