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
  }

  backend "gcs" {
    bucket = "shorted-dev-aba5688f-terraform-state"
    prefix = "env/dev"
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
  ])

  project = var.project_id
  service = each.key

  disable_on_destroy = false
}

# Artifact Registry for Docker images
resource "google_artifact_registry_repository" "shorted" {
  location      = var.region
  repository_id = "shorted"
  description   = "Docker images for Shorted services"
  format        = "DOCKER"
  project       = var.project_id

  labels = {
    environment = "dev"
    managed_by  = "terraform"
  }

  depends_on = [google_project_service.required_apis]
}

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
  environment      = "production"           # Using production since this is the live system
  image_url        = var.short_data_sync_image

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
  environment       = "production" # Using production since this is the live system
  image_url         = var.shorts_api_image
  min_instances     = 1
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
  environment           = "production" # Using production since this is the live system
  image_url             = var.cms_image
  min_instances         = 0
  max_instances         = 10
  mongodb_secret_name   = var.cms_mongodb_secret_name
  allow_unauthenticated = true

  additional_env_vars = {
    PAYLOAD_PUBLIC_SERVER_URL = "https://cms-${var.project_id}.run.app"
  }

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

