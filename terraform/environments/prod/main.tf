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
  to = module.cms.google_service_account.cms
  id = "projects/rosy-clover-477102-t5/serviceAccounts/shorted-cms@rosy-clover-477102-t5.iam.gserviceaccount.com"
}

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

# Note: market_discovery_sync service accounts will be created (don't exist yet in prod)

# Artifact Registry for Docker images
resource "google_artifact_registry_repository" "shorted" {
  location      = var.region
  repository_id = "shorted"
  description   = "Docker images for Shorted services"
  format        = "DOCKER"
  project       = var.project_id

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

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# CMS Service (Payload CMS)
module "cms" {
  source = "../../modules/cms"

  project_id            = var.project_id
  region                = var.region
  environment           = "production"
  image_url             = var.cms_image
  min_instances         = 0
  max_instances         = 10
  mongodb_secret_name   = var.cms_mongodb_secret_name
  allow_unauthenticated = true

  additional_env_vars = {
    PAYLOAD_PUBLIC_SERVER_URL = "https://cms-prod.shorted.com.au"
  }

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}


# Enrichment Processor Job
module "enrichment_processor" {
  source = "../../modules/enrichment-processor"

  project_id        = var.project_id
  region            = var.region
  environment       = "production"
  image_url         = var.enrichment_processor_image
  postgres_address  = var.postgres_address
  postgres_database = var.postgres_database
  postgres_username = var.postgres_username

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
