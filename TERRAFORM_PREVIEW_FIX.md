# Terraform Preview Module Fix

## Issue

Terraform apply was failing with:

```
Error: Provider produced inconsistent result after apply
When applying changes to module.preview.google_cloud_run_v2_service.market_data_preview,
provider "provider[\"registry.terraform.io/hashicorp/google\"]" produced an unexpected new value:
Root resource was present, but now absent.
```

## Root Cause

This is a known Terraform Google provider issue caused by eventual consistency. When Terraform updates Cloud Run services, the provider may check the resource state before GCP has fully propagated the changes, causing it to think the resource is absent.

## Solution

Added three fixes to handle eventual consistency:

### 1. Lifecycle Rules

Added `create_before_destroy = true` to both Cloud Run services to ensure proper update ordering:

```hcl
resource "google_cloud_run_v2_service" "shorts_preview" {
  # ... configuration ...

  lifecycle {
    create_before_destroy = true
  }
}
```

### 2. Ignore Computed Attributes

Added `ignore_changes` to prevent Terraform from detecting changes to computed attributes that can cause inconsistency errors:

```hcl
lifecycle {
  create_before_destroy = true
  ignore_changes = [
    template[0].revision,    # Revision is managed by GCP
    template[0].labels,       # Template labels are computed
    client,                   # Client info is computed
    client_version,           # Client version is computed
  ]
}
```

### 3. Explicit Dependencies

Added explicit `depends_on` blocks to IAM members to ensure they wait for services to be fully created/updated:

```hcl
resource "google_cloud_run_v2_service_iam_member" "shorts_preview_access" {
  # ... configuration ...

  depends_on = [
    google_cloud_run_v2_service.shorts_preview
  ]
}
```

## Changes Made

1. **`terraform/modules/preview/main.tf`**:
   - Added `lifecycle` block with `create_before_destroy = true` and `ignore_changes` to `google_cloud_run_v2_service.shorts_preview`
   - Added `lifecycle` block with `create_before_destroy = true` and `ignore_changes` to `google_cloud_run_v2_service.market_data_preview`
   - Added `depends_on` to `google_cloud_run_v2_service_iam_member.shorts_preview_access`
   - Added `depends_on` to `google_cloud_run_v2_service_iam_member.market_data_preview_access`

The `ignore_changes` prevents Terraform from detecting changes to:

- `template[0].revision` - Managed by GCP, changes on every update
- `template[0].labels` - Computed by GCP
- `client` and `client_version` - Metadata computed by provider

## Testing

After these changes, Terraform apply should:

1. Create/update services with proper lifecycle handling
2. Ignore computed attributes that change during updates (revision, labels, client info)
3. Wait for services to be fully ready before creating IAM members
4. Avoid the "inconsistent result" error during updates

## Next Steps

1. Commit the changes
2. Run `terraform apply` again
3. If the error persists, try:
   - `terraform refresh` to sync state
   - `terraform import` if resources exist but aren't in state
   - Check if services were manually deleted outside Terraform
