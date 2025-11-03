# CI/CD with Terraform - Implementation Plan

## ✅ Completed

1. **Fixed Terraform setup issues**

   - Fixed Cloud Scheduler region (australia-southeast1)
   - Fixed service account name lengths
   - Fixed Docker image configuration
   - Imported existing resources to avoid conflicts

2. **Created Terraform Modules** (4 modules)

   - `stock-price-ingestion` - Stock price data service
   - `short-data-sync` - ASIC short selling data sync job
   - `shorts-api` - Main API service
   - `cms` - Payload CMS

3. **Created Dev Environment**

   - Project: `shorted-dev-aba5688f`
   - All 4 services configured
   - Resources imported successfully
   - Ready to apply: **16 to add, 7 to change, 0 to destroy**

4. **Created Prod Environment**
   - Project: `rosy-clover-477102-t5` (shorted-prod)
   - All 4 services configured
   - Higher instance counts for production
   - Separate configuration from dev

## 🚧 Next Steps (To Complete CI/CD Migration)

### 1. Create Preview/PR Environment Module

Create a flexible module that can deploy PR-specific infrastructure:

```hcl
# terraform/modules/preview-environment/
# - Deploys all services with PR-specific names
# - Minimal instances (cost optimization)
# - Auto-cleanup after PR closes
```

### 2. Update GitHub Actions Workflow

Replace direct `gcloud` commands with Terraform:

**Current workflow:**

- ❌ Uses `gcloud run deploy` directly
- ❌ Only deploys shorts + market-data
- ❌ No sync jobs in CI
- ❌ Hard to maintain/version

**New workflow:**

- ✅ Uses Terraform for all deployments
- ✅ Deploys ALL services (including sync jobs)
- ✅ Versioned infrastructure
- ✅ Supports dev + prod + preview

### 3. CI/CD Stages

#### Stage 1: Build & Push Images

```yaml
- Build all Docker images with tags:
  - PR: `pr-${PR_NUMBER}`
  - Dev: `dev-${SHORT_SHA}`
  - Prod: `v${VERSION}` or `latest`
- Push to Artifact Registry
```

#### Stage 2: Deploy with Terraform

```yaml
# For PRs
- terraform workspace select preview-pr-${PR_NUMBER}
- terraform apply -var="image_tag=pr-${PR_NUMBER}"

# For main branch (dev)
- terraform workspace select dev
- terraform apply -var="image_tag=dev-${SHORT_SHA}"

# For releases (prod)
- terraform workspace select prod
- terraform apply -var="image_tag=v${VERSION}"
```

#### Stage 3: Test & Verify

```yaml
- Run integration tests against deployed services
- Check health endpoints
- Verify all services are running
```

#### Stage 4: Cleanup (PRs only)

```yaml
# When PR closes
- terraform workspace select preview-pr-${PR_NUMBER}
- terraform destroy
- terraform workspace delete preview-pr-${PR_NUMBER}
```

## 📁 New File Structure

```
.github/workflows/
├── ci.yml                    # Main CI/CD workflow (UPDATE THIS)
├── terraform-preview.yml     # PR preview deployments (NEW)
├── terraform-prod.yml        # Production deployments (NEW)
└── terraform-cleanup.yml     # Cleanup closed PRs (NEW)

terraform/
├── modules/
│   ├── stock-price-ingestion/
│   ├── short-data-sync/
│   ├── shorts-api/
│   ├── cms/
│   └── preview-environment/  # NEW - Flexible PR deployments
│
└── environments/
    ├── dev/                  # ✅ DONE
    ├── prod/                 # ✅ DONE
    └── preview/              # NEW - Base config for PRs
```

## 🔧 Implementation Steps

### Step 1: Create Preview Environment Module

```bash
# Create reusable preview module
mkdir -p terraform/modules/preview-environment
cd terraform/modules/preview-environment

# Files to create:
# - main.tf      (all services with pr-specific names)
# - variables.tf (pr_number, image_tags, etc)
# - outputs.tf   (service URLs for testing)
```

### Step 2: Update Makefile

```makefile
# Add commands for different environments
deploy-dev:
	cd terraform/environments/dev && terraform apply

deploy-prod:
	cd terraform/environments/prod && terraform apply

deploy-preview:
	cd terraform/environments/preview && terraform apply \
		-var="pr_number=${PR_NUMBER}" \
		-var="shorts_image=${SHORTS_IMAGE}"

destroy-preview:
	cd terraform/environments/preview && terraform destroy \
		-var="pr_number=${PR_NUMBER}"
```

### Step 3: Update GitHub Secrets

Add these secrets to GitHub repo:

```
# Terraform Cloud (optional, for remote state)
TF_CLOUD_TOKEN

# GCP Workload Identity (already exists)
WIP_PROVIDER
SA_EMAIL
GCP_PROJECT_ID (dev)
GCP_PROJECT_ID_PROD (prod)

# Secrets (already exist)
DATABASE_URL
ALPHA_VANTAGE_API_KEY
```

### Step 4: Create New GitHub Workflows

**`.github/workflows/terraform-preview.yml`**

- Triggered on PR open/sync
- Builds images with `pr-${PR_NUMBER}` tag
- Deploys using Terraform
- Comments deployment URLs on PR

**`.github/workflows/terraform-prod.yml`**

- Triggered on release/tag
- Builds images with version tag
- Deploys to prod using Terraform
- Requires manual approval

**`.github/workflows/terraform-cleanup.yml`**

- Triggered on PR close
- Destroys preview infrastructure
- Cleans up Terraform workspace

### Step 5: Migration Path

1. **Test Terraform in parallel** (don't remove old workflow yet)
2. **Deploy to dev with Terraform** manually first
3. **Create one test PR** with new workflow
4. **Verify preview works** with Terraform
5. **Deploy to prod** with Terraform (during maintenance window)
6. **Remove old gcloud commands** from workflow
7. **Document new process** for team

## 🎯 Benefits

### For PRs (Preview Deployments)

- ✅ **All services** deployed (not just shorts/market-data)
- ✅ **Sync jobs included** for testing data pipelines
- ✅ **Consistent with prod** (same Terraform modules)
- ✅ **Automatic cleanup** when PR closes
- ✅ **Cost-optimized** (minimal instances)

### For Production

- ✅ **Version-controlled infrastructure**
- ✅ **Reproducible deployments**
- ✅ **Easy rollbacks** (Terraform state)
- ✅ **Audit trail** (who deployed what when)
- ✅ **Gradual rollouts** (canary/blue-green possible)

### For Development

- ✅ **Local testing** possible (`terraform plan`)
- ✅ **No more bash scripts** (everything in Terraform)
- ✅ **Self-documenting** (Terraform files show config)
- ✅ **Easier onboarding** (standard Terraform commands)

## 📊 Current Status

| Environment | Status         | Next Action                 |
| ----------- | -------------- | --------------------------- |
| **Dev**     | ✅ Ready       | Run `terraform apply`       |
| **Prod**    | ✅ Ready       | Initialize + create secrets |
| **Preview** | ⬜ Not started | Create preview module       |
| **CI/CD**   | ⬜ Not started | Update workflows            |

## 🚀 Quick Win: Deploy Dev Now

You can deploy dev environment immediately:

```bash
cd terraform/environments/dev
terraform apply  # Will create 16 resources

# Verify
make services
make urls
```

This won't break anything - it will manage existing resources + create new ones (service accounts, IAM, etc).

## 📝 Next Session TODO

1. [ ] Create `terraform/modules/preview-environment/`
2. [ ] Create `.github/workflows/terraform-preview.yml`
3. [ ] Create `.github/workflows/terraform-prod.yml`
4. [ ] Create `.github/workflows/terraform-cleanup.yml`
5. [ ] Update `terraform/Makefile` with new commands
6. [ ] Test preview deployment with one PR
7. [ ] Document the new workflow

## 🔗 Related Documentation

- [terraform/README.md](README.md) - Full Terraform docs
- [terraform/QUICK_START.md](QUICK_START.md) - Getting started
- [terraform/SERVICES.md](SERVICES.md) - Service details
- [terraform/IMPORT_GUIDE.md](IMPORT_GUIDE.md) - Importing existing resources

---

**Ready to proceed?** Let's:

1. Apply dev environment now (`terraform apply`)
2. Create preview module next
3. Update CI/CD workflows after that
