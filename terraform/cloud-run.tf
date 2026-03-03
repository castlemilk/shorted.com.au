terraform {
  required_version = ">= 1.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "australia-southeast2"
}

# Stock Price Ingestion Cloud Run service
resource "google_cloud_run_v2_service" "stock_price_ingestion" {
  name     = "stock-price-ingestion"
  project  = var.project_id
  location = var.region

  template {
    containers {
      image = "australia-southeast2-docker.pkg.dev/${var.project_id}/shorted/stock-price-ingestion:latest"
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
    scaling {
      min_instances = 0
      max_instances = 10
    }
    # Enable CPU throttling to reduce costs when idle
    traffic {
      type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
      percent = 100
    }
    session_affinity = false
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
    container_concurrency = 80

  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

 autogenerate_revision_name = true
}

resource "google_cloud_run_v2_service_iam_binding" "noauth" {
  location = google_cloud_run_v2_service.stock_price_ingestion.location
  name    = google_cloud_run_v2_service.stock_price_ingestion.name
  project = var.project_id
  role    = "roles/run.invoker"
  members = ["allUsers"]
}
