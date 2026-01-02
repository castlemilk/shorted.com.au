# CI/CD Terraform Migration Guide

## Current State vs. Desired State

### ❌ Current CI Pipeline (`ci.yml`)

**What it builds:**

- ✅ Shorts Service (`shorts`)
- ✅ Market Data Service (`market-data`)

**What it's missing:**

- ❌ Stock Price Ingestion (`stock-price-ingestion`)
- ❌ Short Data Sync (`short-data-sync`)
- ❌ CMS (`cms`)

**Deployment method:**

- Uses direct `gcloud run deploy` commands
- Hardcoded configuration in workflow
- No infrastructure versioning
- Manual cleanup required for PRs

### ✅ New Terraform Pipeline (`terraform-deploy.yml`)

**What it builds:**

- ✅ Shorts Service
- ✅ Market Data Service
- ✅ Stock Price Ingestion (**NEW**)
- ✅ Short Data Sync (**NEW**)
- ✅ CMS (**NEW**)

**Deployment method:**

- Uses Terraform for all deployments
- Configuration in version-controlled `.tf` files
- Infrastructure as Code
- Automated state management

## Key Improvements

### 1. Complete Service Coverage

```yaml
# Old: Only 2 services
services: [shorts, market-data]

# New: All 5 services
services:
  - shorts
  - market-data
  - stock-price-ingestion  # ← NEW
  - short-data-sync        # ← NEW
  - cms                    # ← NEW
```

### 2. Infrastructure as Code

```yaml
# Old: Direct gcloud commands
gcloud run deploy shorts-service-pr-44 \
  --image ... \
  --set-env-vars="..." \
  --memory 256Mi

# New: Terraform modules
terraform apply \
  -var="shorts_api_image=..."
# All configuration in version-controlled .tf files
```

### 3. Environment Management

| Environment    | Old Workflow | New Workflow |
| -------------- | ------------ | ------------ |
| **PR Preview** | ✅ Deployed  | ✅ Deployed  |
| **Dev**        | ❌ Manual    | ✅ Automated |
| **Prod**       | ❌ Manual    | ✅ Automated |

### 4. Service Discovery

```yaml
# Old: Hardcoded URLs in workflow
SHORTS_URL="https://shorts-service-pr-44-..."

# New: Terraform outputs
shorts_url=$(terraform output -raw shorts_api_url)
stock_price_url=$(terraform output -raw stock_price_ingestion_url)
```

## Migration Steps

### Phase 1: Test in Parallel (Safe)

1. **Keep existing `ci.yml`** (unchanged)
2. **Add new `terraform-deploy.yml`** (runs in parallel)
3. **Test with feature branch**
4. **Verify all services deploy correctly**

### Phase 2: Migrate PRs

1. **Update `ci.yml`** to use Terraform for PRs
2. **Keep old workflow as fallback**
3. **Monitor several PRs**
4. **Fix any issues**

### Phase 3: Migrate Main/Prod

1. **Update main branch** deployments to use Terraform
2. **Deploy to prod** during maintenance window
3. **Remove old `gcloud` commands**
4. **Archive old workflow**

## New Workflow Behavior

### For Pull Requests

```yaml
# What happens:
1. Build all 5 service images with tag `pr-${PR_NUMBER}`
2. Push to dev Artifact Registry
3. Run `terraform plan` (shows what would change)
4. Comment plan on PR (for review)
5. Do NOT apply (preview only)
# Result: PR gets plan preview, no actual deployment
# (We can enable preview deployments later if needed)
```

### For Main Branch Push

```yaml
# What happens:
1. Build all 5 service images with tag `dev-${SHORT_SHA}`
2. Push to dev Artifact Registry
3. Run `terraform apply` to dev environment
4. All services updated in dev
5. Run integration tests
# Result: Dev environment always up-to-date with main
```

### For Release/Tag

```yaml
# What happens:
1. Build all 5 service images with tag `v${VERSION}`
2. Push to prod Artifact Registry
3. Run `terraform apply` to prod environment
4. All services updated in prod
5. Run smoke tests
# Result: Prod deployment with version tags
```

## Docker Build Matrix

The new workflow uses a build matrix to build all services in parallel:

```yaml
strategy:
  matrix:
    service:
      - name: shorts
        dockerfile: shorts/Dockerfile
        context: services
      - name: market-data
        dockerfile: market-data/Dockerfile
        context: services
      - name: stock-price-ingestion # ← NEW
        dockerfile: stock-price-ingestion/Dockerfile
        context: services/stock-price-ingestion
      - name: short-data-sync # ← NEW
        dockerfile: short-data-sync/Dockerfile
        context: services/short-data-sync
      - name: cms # ← NEW
        dockerfile: cms/Dockerfile
        context: cms
```

This builds all images in parallel for faster CI.

## Required GitHub Secrets

### Existing (Already configured)

- ✅ `WIP_PROVIDER` - Workload Identity Provider
- ✅ `SA_EMAIL` - Service Account Email
- ✅ `GCP_PROJECT_ID` - Dev project ID
- ✅ `DATABASE_URL` - Database connection

### New (May need to add)

- ⬜ `GCP_PROJECT_ID_PROD` - Prod project ID (`rosy-clover-477102-t5`)
- ⬜ `TF_CLOUD_TOKEN` - Terraform Cloud token (optional, for remote state)

## Benefits Summary

### ✅ Complete Coverage

- All 5 services in CI/CD
- Sync jobs included
- No manual deployments needed

### ✅ Version Control

- Infrastructure configuration in Git
- Easy rollbacks
- Audit trail

### ✅ Consistency

- Same Terraform modules for dev/prod
- Reduces configuration drift
- Single source of truth

### ✅ Automation

- Automatic deployments on merge
- Automatic cleanup (future)
- Reduced manual work

### ✅ Testing

- Can test against deployed infrastructure
- Integration tests built-in
- Easier debugging

## Rollout Plan

### Week 1: Setup & Test

```bash
# 1. Create feature branch
git checkout -b feat/terraform-cicd

# 2. Add new workflow
cp .github/workflows/terraform-deploy.yml.new .github/workflows/terraform-deploy.yml

# 3. Test manually
gh workflow run terraform-deploy.yml --ref feat/terraform-cicd

# 4. Verify all services build
# 5. Verify Terraform plan works
```

### Week 2: PR Preview

```bash
# 1. Enable Terraform deployment for PRs
# 2. Test with real PR
# 3. Verify plan comments work
# 4. Fix any issues
```

### Week 3: Dev Deployment

```bash
# 1. Enable Terraform apply on main merge
# 2. Merge to main
# 3. Verify dev deployment
# 4. Run integration tests
```

### Week 4: Prod Deployment

```bash
# 1. Create release
# 2. Terraform applies to prod
# 3. Verify all services
# 4. Remove old workflow
```

## Testing Checklist

Before going live, test:

- [ ] All 5 Docker images build successfully
- [ ] Images push to Artifact Registry
- [ ] Terraform init works
- [ ] Terraform plan succeeds
- [ ] Terraform apply works (in dev first)
- [ ] Services start successfully
- [ ] Health checks pass
- [ ] Integration tests pass
- [ ] Rollback works (revert and redeploy)

## Troubleshooting

### Image build fails

```bash
# Test locally
cd services/stock-price-ingestion
docker build -t test:local .
```

### Terraform fails

```bash
# Run locally
cd terraform/environments/dev
terraform init
terraform plan
```

### Service won't start

```bash
# Check logs
gcloud logging read "resource.type=cloud_run_revision" --limit 50
```

## Next Steps

1. **Review this guide** with the team
2. **Test `terraform-deploy.yml`** with manual workflow dispatch
3. **Create test PR** to verify build matrix
4. **Enable for main branch** once tested
5. **Deploy to prod** during maintenance window
6. **Archive old workflow** once stable

---

**Questions?** Check:

- [terraform/CI_CD_TERRAFORM_PLAN.md](../../terraform/CI_CD_TERRAFORM_PLAN.md)
- [terraform/README.md](../../terraform/README.md)
- [TERRAFORM_COMPLETE.md](../../TERRAFORM_COMPLETE.md)
