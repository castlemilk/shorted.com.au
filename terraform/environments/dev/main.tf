/**
 * Development Environment
 * Manages all infrastructure for the shorted-dev-aba5688f project
 */

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.9"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.19"
    }
  }

  # Backend lives in backend.tf (GCS, re-enabled June 2026).
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "cloudflare" {
  # Prefer the scoped API Token (set CLOUDFLARE_API_TOKEN env var or
  # var.cloudflare_api_token). Fall back to legacy api_key + email when
  # neither is provided — keeps existing local-dev tfvars working.
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : null
  api_key   = var.cloudflare_api_token == "" && var.cloudflare_global_api_key != "" ? var.cloudflare_global_api_key : null
  email     = var.cloudflare_api_token == "" && var.cloudflare_email != "" ? var.cloudflare_email : null
}

# Enable required APIs
# DISABLED: APIs already enabled in GCP; terraform lacks serviceusage.services.list permission
# to manage these resources with the current gcloud credentials.
# resource "google_project_service" "required_apis" {
#   for_each = toset([
#     "run.googleapis.com",
#     "cloudscheduler.googleapis.com",
#     "artifactregistry.googleapis.com",
#     "secretmanager.googleapis.com",
#     "compute.googleapis.com",
#     "iam.googleapis.com",
#     "pubsub.googleapis.com",
#   ])
#   project = var.project_id
#   service = each.key
#   disable_on_destroy = false
# }

# Wait for APIs to fully propagate before creating resources
# Artifact Registry API can take up to 60s to fully propagate in GCP
resource "time_sleep" "wait_for_apis" {
  depends_on      = [] # google_project_service.required_apis disabled — APIs already enabled
  create_duration = "60s"
}

# Import existing Artifact Registry repository into Terraform state (if it exists)
# DISABLED: requires artifact registry read permission not available to current gcloud credentials
# import {
#   to = google_artifact_registry_repository.shorted
#   id = "projects/shorted-dev-aba5688f/locations/australia-southeast2/repositories/shorted"
# }

# Import existing bucket in dev project (DISABLED — requires storage.buckets.get permission)
# import {
#   to = module.short_data_sync.google_storage_bucket.short_selling_data
#   id = "shorted-short-selling-data"
# }

# Artifact Registry for Docker images
# DISABLED: repository already exists in GCP — cannot manage without artifact registry read permission
# resource "google_artifact_registry_repository" "shorted" {
#   location      = var.region
#   repository_id = "shorted"
#   description   = "Docker images for Shorted services"
#   format        = "DOCKER"
#   project       = var.project_id
#   labels = {
#     environment = "dev"
#     managed_by  = "terraform"
#   }
#   depends_on = [time_sleep.wait_for_apis]
# }

# Stock Price Ingestion Service
module "stock_price_ingestion" {
  source = "../../modules/stock-price-ingestion"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"           # Using production since this is the live system
  image_url        = var.stock_price_ingestion_image
  min_instances    = 0
  max_instances    = 10

  depends_on = [
  ]
}

# Short Data Sync Job
module "short_data_sync" {
  source = "../../modules/short-data-sync"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"           # Using production since this is the live system
  image_url        = var.short_data_sync_image
  bucket_name      = "shorted-short-selling-data" # Existing bucket in dev project

  depends_on = [
  ]
}

# House-price collector (ABS/RBA quarterly ingest + MV refresh)
module "house_price_collector" {
  source = "../../modules/house-price-collector"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url        = var.house_price_collector_image
}

# Economy collector (ABS/RBA/DCCEEW monthly ingest)
module "economy_collector" {
  source = "../../modules/economy-collector"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url        = var.economy_collector_image
}

# Shorts API Service
module "shorts_api" {
  source = "../../modules/shorts-api"

  project_id        = var.project_id
  region            = var.region
  environment       = "production" # Using production since this is the live system
  image_url         = var.shorts_api_image
  min_instances     = 0 # Scale to zero when idle
  max_instances     = 100
  postgres_address  = var.postgres_address
  postgres_database = var.postgres_database
  postgres_username = var.postgres_username

  scheduler_region             = "australia-southeast1"
  enable_key_metrics_scheduler = false # Disabled: secret INTERNAL_METRICS_SCHEDULER_SECRET not accessible to terraform SA (secretmanager.versions.get denied)

  depends_on = [
  ]
}

# Enrichment Processor Job
module "enrichment_processor" {
  source = "../../modules/enrichment-processor"

  project_id        = var.project_id
  region            = var.region
  environment       = "production" # Using production since this is the live system
  image_url         = var.enrichment_processor_image
  postgres_address  = var.postgres_address
  postgres_database = var.postgres_database
  postgres_username = var.postgres_username
  shorts_api_url    = module.shorts_api.service_url

  depends_on = [
  ]
}

# Market Data API Service (Connect-RPC, port 8090)
module "market_data" {
  source = "../../modules/market-data"

  project_id    = var.project_id
  region        = var.region
  environment   = "dev"
  image_url     = var.market_data_image
  min_instances = 0
  max_instances = 10

  depends_on = [
  ]
}

# =============================================================================
# Chat Service — NOT managed in dev. The chat-service image is not built by the
# dev CI matrix (its :latest tag no longer exists in the dev registry), so every
# apply tainted/failed on it. The live dev service was `state rm`'d (left running,
# unmanaged) rather than destroyed. Chat is exercised in prod; dev doesn't need it.
# =============================================================================

# Market Discovery and Data Sync Jobs
module "market_discovery_sync" {
  source = "../../modules/market-discovery-sync"

  project_id             = var.project_id
  region                 = var.region
  scheduler_region       = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment            = "dev"
  asx_discovery_image    = var.asx_discovery_image
  market_data_sync_image = var.market_data_sync_image
  bucket_name            = module.short_data_sync.bucket_name
  min_instances          = 0
  max_instances          = 10

  depends_on = [
    module.short_data_sync
  ]
}

# =============================================================================
# Grafana Cloud Dashboards — managed by environments/prod ONLY. There is a single
# Grafana Cloud org (skunkworq.grafana.net); dev co-managing the same folder meant
# a dev apply could delete/overwrite prod's dashboards, and dev CI has no Grafana
# token (the folder read 403'd every plan). Removed alongside the dev cleanup;
# the folder resource was `state rm`'d, not destroyed. (Same posture as Cloudflare.)
# =============================================================================

# Weekly Report Generator Job
module "weekly_report_generator" {
  source = "../../modules/weekly-report-generator"

  project_id           = var.project_id
  region               = var.region
  scheduler_region     = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment          = "production"
  image_url            = var.weekly_report_generator_image
  gemini_secret_exists = var.gemini_secret_exists

  depends_on = [
  ]
}

# News Aggregator Job (RSS feeds → news_articles table)
module "news_aggregator" {
  source = "../../modules/news-aggregator"

  project_id           = var.project_id
  region               = var.region
  scheduler_region     = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment          = "dev"
  image_url            = var.news_aggregator_image
  gemini_secret_exists = var.gemini_secret_exists

  depends_on = [
  ]
}

# ASX Announcement Crawler Job (director trades, dividends, news from ASX)
module "asx_announcement_crawler" {
  source = "../../modules/asx-announcement-crawler"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "dev"
  image_url        = var.asx_announcement_crawler_image

  depends_on = [
  ]
}

# Signals collector — brandbrain risk/reputation signals (§6.9). Scale-to-zero job.
module "signals_collector" {
  source = "../../modules/signals-collector"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1"
  environment      = "dev"
  image_url        = var.signals_collector_image

  depends_on = [
  ]
}

# Report extractor — director-trade + financial-report digest jobs (§6.9). Scale-to-zero.
module "report_extractor" {
  source = "../../modules/report-extractor"

  project_id           = var.project_id
  region               = var.region
  scheduler_region     = "australia-southeast1"
  environment          = "dev"
  image_url            = var.report_extractor_image
  gemini_secret_exists = var.gemini_secret_exists

  depends_on = [
  ]
}

# =============================================================================
# Cloudflare Edge — managed by environments/prod ONLY.
# There is a single shorted.com.au zone; dev previously co-managed the same
# worker/DNS/rulesets, meaning a dev apply could overwrite prod's edge with
# dev origins. Removed June 2026 when the dev GCS backend was re-enabled.
# =============================================================================

# =============================================================================
# Newsroom Daily Job — NOT managed in dev. It requires the ANTHROPIC_API_KEY
# secret (absent in dev → apply 403'd), and we don't want a dev scheduler
# publishing daily takes. The newsroom runs in prod (and locally/manually).
# The tainted dev job was `state rm`'d (left unmanaged), not destroyed.
# =============================================================================
