# Terraform Infrastructure for Shorted.com.au

This directory contains Terraform configurations for managing all cloud infrastructure for the Shorted project.

## Structure

```
terraform/
├── modules/
│   ├── stock-price-ingestion/    # Stock price data ingestion
│   ├── short-data-sync/          # ASIC short selling data sync
│   ├── shorts-api/               # Main Shorts API service
│   └── cms/                      # Payload CMS
│
└── environments/
    └── dev/                       # Development environment
        ├── main.tf                # Environment-specific resources
        ├── variables.tf           # Environment variables
        ├── outputs.tf             # Environment outputs
        └── terraform.tfvars       # Variable values (gitignored)
```

## What's Managed by Terraform

### ✅ Services

#### 1. Stock Price Ingestion Service

- **Cloud Run Service** - Fetches ASX stock prices (Alpha Vantage + Yahoo Finance)
- **Cloud Scheduler Jobs**:
  - Daily sync (weekdays at 6 PM AEST)
  - Weekly backfill (Sundays at 8 PM AEST)

#### 2. Short Data Sync Job

- **Cloud Run Job** - Downloads ASIC short selling data
- **GCS Bucket** - Stores CSV files with versioning
- **Cloud Scheduler Job** - Daily at 8 PM AEST

#### 3. Shorts API

- **Cloud Run Service** - Main API service for stock shorts data
- **Always-on** - Min 1 instance for low latency
- **gRPC/Connect RPC** - Protocol buffer based API

#### 4. CMS (Payload CMS)

- **Cloud Run Service** - Content management system
- **Admin Interface** - Manage metadata, blog posts, media

### ✅ Infrastructure

- **Artifact Registry** - Docker image storage
- **Service Accounts** - One per service with minimal permissions
- **IAM Bindings** - Secret Manager access
- **API Enablement** - All required GCP APIs

### 🔐 Secrets (Referenced, Not Created)

Terraform references but doesn't create secret values. Create these separately:

- `ALPHA_VANTAGE_API_KEY` - Alpha Vantage API key
- `DATABASE_URL` - PostgreSQL connection string
- `APP_STORE_POSTGRES_PASSWORD` - Postgres password
- `MONGODB_URI` - MongoDB connection (optional, for CMS)

📚 **For detailed service documentation, see [SERVICES.md](SERVICES.md)**

## Prerequisites

### 1. Install Terraform

```bash
# macOS
brew tap hashicorp/tap
brew install hashicorp/tap/terraform

# Verify installation
terraform version
```

### 2. Authenticate with GCP

```bash
gcloud auth application-default login
gcloud config set project shorted-dev-aba5688f
```

### 3. Create Secrets (First Time Only)

```bash
# Create secrets using the setup script
cd services/stock-price-ingestion
./setup-secrets.sh
```

## Quick Start

### Initialize Terraform

```bash
cd terraform/environments/dev

# Initialize Terraform (downloads providers)
terraform init
```

### Review Changes

```bash
# See what Terraform will do (dry run)
terraform plan
```

### Apply Changes

```bash
# Apply the configuration
terraform apply

# Or auto-approve
terraform apply -auto-approve
```

### View Outputs

```bash
# Show all outputs
terraform output

# Show specific output
terraform output stock_price_ingestion_url
```

## Common Workflows

### Deploy a New Service Version

1. **Build and push Docker image**:

   ```bash
   cd services/stock-price-ingestion
   ./docker-build-push.sh
   ```

2. **Update image in Terraform** (optional - uses `:latest` by default):

   ```bash
   cd terraform/environments/dev
   # Edit terraform.tfvars to set specific image tag
   terraform apply
   ```

3. **Or use default `:latest` tag**:
   ```bash
   terraform apply
   ```

### Update Scheduler Configuration

```bash
# Edit the module configuration
cd terraform/modules/stock-price-ingestion
# Modify schedule in main.tf

# Apply changes
cd ../../environments/dev
terraform apply
```

### Add a New Service

1. **Create module**:

   ```bash
   mkdir -p terraform/modules/my-new-service
   # Add main.tf, variables.tf, outputs.tf
   ```

2. **Reference in environment**:

   ```bash
   # Edit terraform/environments/dev/main.tf
   module "my_new_service" {
     source = "../../modules/my-new-service"
     # ... configuration
   }
   ```

3. **Apply**:
   ```bash
   cd terraform/environments/dev
   terraform apply
   ```

## State Management

### Local State (Current)

State is stored locally in `terraform.tfstate`. **Do not commit this file!**

### Remote State (Recommended for Team)

```bash
# Create GCS bucket for state
gsutil mb -p shorted-dev-aba5688f -l australia-southeast2 gs://shorted-dev-terraform-state

# Enable versioning
gsutil versioning set on gs://shorted-dev-terraform-state

# Uncomment backend configuration in main.tf
cd terraform/environments/dev
terraform init -migrate-state
```

## Advanced Usage

### Targeting Specific Resources

```bash
# Apply only the stock price ingestion module
terraform apply -target=module.stock_price_ingestion

# Destroy only the scheduler jobs
terraform destroy -target=module.stock_price_ingestion.google_cloud_scheduler_job.daily_sync
```

### Import Existing Resources

```bash
# Import an existing Cloud Run service
terraform import module.stock_price_ingestion.google_cloud_run_v2_service.stock_price_ingestion \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/services/stock-price-ingestion
```

### Workspace for Multiple Environments

```bash
# Create production workspace
terraform workspace new prod

# Switch workspaces
terraform workspace select dev
terraform workspace select prod

# List workspaces
terraform workspace list
```

## Troubleshooting

### "Resource already exists" Error

```bash
# Import the existing resource
terraform import <resource_type>.<resource_name> <resource_id>

# Or destroy and recreate
terraform destroy -target=<resource>
terraform apply
```

### "API not enabled" Error

```bash
# Enable APIs manually
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com

# Or wait for Terraform to enable them
terraform apply
```

### State Drift

```bash
# Detect drift
terraform plan -refresh-only

# Sync state with reality
terraform apply -refresh-only
```

## Best Practices

✅ **Version Control**: Commit all `.tf` files, exclude `terraform.tfstate` and `terraform.tfvars`  
✅ **Module Reuse**: Create modules for reusable infrastructure patterns  
✅ **Remote State**: Use GCS backend for team collaboration  
✅ **Code Reviews**: Review `terraform plan` output before applying  
✅ **Incremental Changes**: Apply small, focused changes  
✅ **Documentation**: Document non-obvious configurations

## Migration from Bash Scripts

If you have existing resources deployed via bash scripts:

1. **Document existing resources**:

   ```bash
   gcloud run services list --project=shorted-dev-aba5688f
   gcloud scheduler jobs list --project=shorted-dev-aba5688f
   ```

2. **Import into Terraform**:

   ```bash
   terraform import <resource_type>.<name> <resource_id>
   ```

3. **Verify**:

   ```bash
   terraform plan  # Should show no changes
   ```

4. **Decommission bash scripts** once everything is in Terraform

## Additional Resources

- [Terraform Google Provider Docs](https://registry.terraform.io/providers/hashicorp/google/latest/docs)
- [Cloud Run Terraform Resource](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_run_v2_service)
- [Cloud Scheduler Terraform Resource](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_scheduler_job)
- [Terraform Best Practices](https://www.terraform-best-practices.com/)
