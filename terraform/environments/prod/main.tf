/**
 * Production Environment
 * Manages all infrastructure for the shorted-prod project
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
  }

  backend "gcs" {
    bucket = "rosy-clover-477102-t5-terraform-state"
    prefix = "env/prod"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "required_apis" {
  for_each = toset([
    "run.googleapis.com",
    "cloudscheduler.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "pubsub.googleapis.com",
  ])

  project = var.project_id
  service = each.key

  disable_on_destroy = false
}

# Wait for APIs to fully propagate before creating resources
# Artifact Registry API can take up to 60s to fully propagate in GCP
resource "time_sleep" "wait_for_apis" {
  depends_on      = [google_project_service.required_apis]
  create_duration = "60s"
}

# Import existing Artifact Registry repository into Terraform state
import {
  to = google_artifact_registry_repository.shorted
  id = "projects/rosy-clover-477102-t5/locations/australia-southeast2/repositories/shorted"
}

# Import existing service accounts
import {
  to = module.shorts_api.google_service_account.shorts_api
  id = "projects/rosy-clover-477102-t5/serviceAccounts/shorts@rosy-clover-477102-t5.iam.gserviceaccount.com"
}

import {
  to = module.stock_price_ingestion.google_service_account.stock_price_ingestion
  id = "projects/rosy-clover-477102-t5/serviceAccounts/stock-price-ingestion@rosy-clover-477102-t5.iam.gserviceaccount.com"
}

# Note: Bucket 'shorted-short-selling-data' is used by dev project
# Prod uses a separate bucket name

# Import short-data-sync service accounts
import {
  to = module.short_data_sync.google_service_account.short_data_sync
  id = "projects/rosy-clover-477102-t5/serviceAccounts/shorts-data-sync@rosy-clover-477102-t5.iam.gserviceaccount.com"
}

import {
  to = module.short_data_sync.google_service_account.scheduler_invoker
  id = "projects/rosy-clover-477102-t5/serviceAccounts/shorts-data-sync-scheduler@rosy-clover-477102-t5.iam.gserviceaccount.com"
}

# Import enrichment-processor service account
import {
  to = module.enrichment_processor.google_service_account.enrichment_processor
  id = "projects/rosy-clover-477102-t5/serviceAccounts/enrichment-processor@rosy-clover-477102-t5.iam.gserviceaccount.com"
}

# Import existing market-data Cloud Run service (was previously deployed outside Terraform)
import {
  to = module.market_data.google_cloud_run_v2_service.market_data
  id = "projects/rosy-clover-477102-t5/locations/australia-southeast2/services/market-data"
}

# Note: market_discovery_sync service accounts will be created (don't exist yet in prod)

# Artifact Registry for Docker images
resource "google_artifact_registry_repository" "shorted" {
  location      = var.region
  repository_id = "shorted"
  description   = "Docker images for Shorted services"
  format        = "DOCKER"
  project       = var.project_id

  cleanup_policy {
    id     = "keep-latest-10-images"
    action = "KEEP"
    mode   = "KEEP_VERSIONS"
    criteria {
      most_recent_versions = 10
    }
  }

  labels = {
    environment = "prod"
    managed_by  = "terraform"
  }

  depends_on = [time_sleep.wait_for_apis]
}

# Stock Price Ingestion Service
module "stock_price_ingestion" {
  source = "../../modules/stock-price-ingestion"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url        = var.stock_price_ingestion_image
  min_instances    = 0
  max_instances    = 20 # Higher for production

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# Short Data Sync Job
module "short_data_sync" {
  source = "../../modules/short-data-sync"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url        = var.short_data_sync_image
  bucket_name      = "shorted-short-selling-data-prod" # Prod-specific bucket

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# Shorts API Service
module "shorts_api" {
  source = "../../modules/shorts-api"

  project_id        = var.project_id
  region            = var.region
  environment       = "production"
  image_url         = var.shorts_api_image
  min_instances     = 0 # Scale to zero when idle
  max_instances     = 100
  postgres_address  = var.postgres_address
  postgres_database = var.postgres_database
  postgres_username = var.postgres_username

  scheduler_region             = "australia-southeast1"
  enable_key_metrics_scheduler = true

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# Enrichment Processor Service
module "enrichment_processor" {
  source = "../../modules/enrichment-processor"

  project_id        = var.project_id
  region            = var.region
  environment       = "production"
  image_url         = var.enrichment_processor_image
  image_tag         = var.image_tag
  postgres_address  = var.postgres_address
  postgres_database = var.postgres_database
  postgres_username = var.postgres_username
  shorts_api_url    = module.shorts_api.service_url

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# Grafana Cloud Dashboards
module "grafana_dashboards" {
  source = "../../modules/grafana-dashboards"

  grafana_url  = var.grafana_url
  grafana_auth = var.grafana_auth
}

# Weekly Report Generator Job
module "weekly_report_generator" {
  source = "../../modules/weekly-report-generator"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url            = var.weekly_report_generator_image
  gemini_secret_exists = false # GEMINI_API_KEY not yet provisioned in prod

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# Market Data API Service (Connect-RPC, port 8090)
module "market_data" {
  source = "../../modules/market-data"

  project_id    = var.project_id
  region        = var.region
  environment   = "production"
  image_url     = var.market_data_image
  min_instances = 0
  max_instances = 10

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# Market Discovery and Data Sync Jobs
module "market_discovery_sync" {
  source = "../../modules/market-discovery-sync"

  project_id             = var.project_id
  region                 = var.region
  scheduler_region       = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment            = "production"
  asx_discovery_image    = var.asx_discovery_image
  market_data_sync_image = var.market_data_sync_image
  bucket_name            = module.short_data_sync.bucket_name

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted,
    module.short_data_sync
  ]
}

# News Aggregator Job (RSS feeds → news_articles table)
module "news_aggregator" {
  source = "../../modules/news-aggregator"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url        = var.news_aggregator_image

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# ASX Announcement Crawler Job (director trades, dividends, news from ASX)
module "asx_announcement_crawler" {
  source = "../../modules/asx-announcement-crawler"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url        = var.asx_announcement_crawler_image

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}
