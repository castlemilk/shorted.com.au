# GCS Backend for Terraform State

## Overview

Terraform state is now stored in Google Cloud Storage (GCS) buckets for both local development and CI/CD. This provides:

- ✅ **Shared State**: Same state file for local dev and CI
- ✅ **State Locking**: Prevents concurrent modifications
- ✅ **Versioning**: State history for rollbacks
- ✅ **Backup**: Automatic backups in GCS
- ✅ **Team Collaboration**: Multiple developers can work safely

## Setup

### Dev Environment

**Bucket:** `gs://shorted-dev-aba5688f-terraform-state`

Already configured and migrated! State is stored at:
- Dev: `gs://shorted-dev-aba5688f-terraform-state/env/dev/default.tfstate`
- Previews: `gs://shorted-dev-aba5688f-terraform-state/preview/pr-{NUMBER}/default.tfstate`

### Prod Environment

**Bucket:** `gs://rosy-clover-477102-t5-terraform-state`

To set up prod:

```bash
cd terraform
./setup-gcs-backend.sh prod
cd environments/prod
terraform init -migrate-state
```

## Backend Configuration

### Dev (`terraform/environments/dev/main.tf`)
```hcl
backend "gcs" {
  bucket = "shorted-dev-aba5688f-terraform-state"
  prefix = "env/dev"
}
```

### Prod (`terraform/environments/prod/main.tf`)
```hcl
backend "gcs" {
  bucket = "rosy-clover-477102-t5-terraform-state"
  prefix = "env/prod"
}
```

### Preview (PR deployments in CI)
```hcl
backend "gcs" {
  bucket = "shorted-dev-aba5688f-terraform-state"
  prefix = "preview/pr-44"  # Dynamic per PR
}
```

## How It Works

### Local Development

When you run `terraform apply` locally:

```bash
cd terraform/environments/dev
terraform init  # Connects to GCS backend
terraform plan  # Reads state from GCS
terraform apply # Updates state in GCS
```

Terraform automatically:
1. Downloads current state from GCS
2. Acquires a lock on the state file
3. Applies changes
4. Uploads new state to GCS
5. Releases the lock

### CI/CD Pipeline

When GitHub Actions runs:

```yaml
# For PRs (preview deployments)
backend "gcs" {
  bucket = "shorted-dev-aba5688f-terraform-state"
  prefix = "preview/pr-44"
}

# For main branch (dev environment)
backend "gcs" {
  bucket = "shorted-dev-aba5688f-terraform-state"
  prefix = "env/dev"
}

# For releases (prod environment)
backend "gcs" {
  bucket = "rosy-clover-477102-t5-terraform-state"
  prefix = "env/prod"
}
```

## State Locking

GCS backend provides automatic state locking:

- ✅ Only one operation at a time
- ✅ Prevents race conditions
- ✅ Automatic lock timeout (30 seconds)
- ✅ Manual unlock if needed: `terraform force-unlock <LOCK_ID>`

## State Versioning

All buckets have versioning enabled:

- **Keeps history**: Previous states are preserved
- **Rollback capability**: Can recover from mistakes
- **Lifecycle policy**: Old versions auto-deleted after 30 days

To list state versions:

```bash
gsutil ls -a gs://shorted-dev-aba5688f-terraform-state/env/dev/
```

To restore a previous version:

```bash
# List versions with timestamps
gsutil ls -la gs://shorted-dev-aba5688f-terraform-state/env/dev/default.tfstate

# Download specific version
gsutil cp gs://shorted-dev-aba5688f-terraform-state/env/dev/default.tfstate#<generation> ./

# Restore it
gsutil cp ./default.tfstate gs://shorted-dev-aba5688f-terraform-state/env/dev/default.tfstate
```

## Troubleshooting

### "Backend initialization required"

```bash
cd terraform/environments/dev
terraform init -reconfigure
```

### "Error acquiring state lock"

Someone else is running Terraform, or a previous run failed. Wait or force unlock:

```bash
terraform force-unlock <LOCK_ID>
```

### "Failed to load state from backend"

Check GCS permissions:

```bash
gsutil iam get gs://shorted-dev-aba5688f-terraform-state
gcloud projects get-iam-policy shorted-dev-aba5688f
```

### "Backend configuration changed"

Run init with migration:

```bash
terraform init -migrate-state
```

## Best Practices

### 1. Never Delete State Files

State files are critical. Never manually delete them from GCS!

### 2. Use State Locking

Always let Terraform manage the lock. Don't force-unlock unless necessary.

### 3. Review State Before Changes

```bash
terraform state list
terraform state show <resource>
```

### 4. Backup Before Major Changes

```bash
# Download current state
gsutil cp gs://shorted-dev-aba5688f-terraform-state/env/dev/default.tfstate ./backup.tfstate
```

### 5. Use Workspaces for Isolation

For testing, use Terraform workspaces:

```bash
terraform workspace new test
terraform workspace select test
# State stored at: env/dev/env/test/default.tfstate
```

## Security

### IAM Permissions

The service account needs:

```
roles/storage.objectAdmin  # For state files
roles/storage.legacyBucketWriter  # For locking
```

Currently configured for:
- Your user account (local development)
- GitHub Actions service account (CI/CD)

### State Encryption

- ✅ **In transit**: TLS to/from GCS
- ✅ **At rest**: Google-managed encryption keys
- ⬜ **Optional**: Customer-managed encryption keys (CMEK)

## Monitoring

### Check State File

```bash
# View state metadata
gsutil ls -L gs://shorted-dev-aba5688f-terraform-state/env/dev/default.tfstate

# Download and inspect
gsutil cp gs://shorted-dev-aba5688f-terraform-state/env/dev/default.tfstate - | jq '.version'
```

### View State in Console

https://console.cloud.google.com/storage/browser/shorted-dev-aba5688f-terraform-state

## Cleanup (PR Previews)

When a PR closes, the workflow automatically:

1. Initializes Terraform with the PR's GCS state
2. Runs `terraform destroy` 
3. Removes the GCS state file
4. Cleans up Cloud Run services

Preview states are stored at:
```
gs://shorted-dev-aba5688f-terraform-state/preview/pr-44/
gs://shorted-dev-aba5688f-terraform-state/preview/pr-45/
...
```

## Cost

GCS state storage costs:

- **Storage**: ~$0.02/GB/month (negligible, states are KB)
- **Operations**: ~$0.005/10k operations (very low)
- **Total**: ~$0.50/month for all environments

## Migration Summary

### What Changed

**Before:**
- State stored locally in `terraform.tfstate`
- Not shared between developers
- No history or versioning
- CI created temporary state (lost after run)

**After:**
- State stored in GCS
- Shared across team
- Versioned with 30-day history
- CI uses persistent state
- Automatic state locking

### Migration Steps Completed

1. ✅ Created GCS bucket: `shorted-dev-aba5688f-terraform-state`
2. ✅ Enabled versioning on bucket
3. ✅ Updated `terraform/environments/dev/main.tf` with backend config
4. ✅ Updated `terraform/environments/prod/main.tf` with backend config
5. ✅ Migrated dev state from local to GCS
6. ✅ Updated CI workflow to use GCS backend
7. ✅ Updated cleanup job to use GCS backend

---

**Status**: ✅ GCS backend fully configured and operational!

