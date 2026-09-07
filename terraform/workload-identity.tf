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

variable "github_org" {
  description = "GitHub organization or username"
  type        = string
  default     = "benebsworth" # Update this with your GitHub username/org
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "shorted"
}

# Enable required APIs
resource "google_project_service" "required_apis" {
  for_each = toset([
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
  ])

  project = var.project_id
  service = each.key

  disable_on_destroy = false
}

# Create Workload Identity Pool
resource "google_iam_workload_identity_pool" "github_pool" {
  project                   = var.project_id
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions Pool"
  description               = "Workload Identity Pool for GitHub Actions"

  depends_on = [google_project_service.required_apis]
}

# Create Workload Identity Provider
resource "google_iam_workload_identity_pool_provider" "github_provider" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_pool.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub Provider"
  description                        = "OIDC provider for GitHub Actions"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.actor"            = "assertion.actor"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
  }

  attribute_condition = "assertion.repository_owner == '${var.github_org}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Create Service Account for GitHub Actions
resource "google_service_account" "github_actions" {
  project      = var.project_id
  account_id   = "github-actions-sa"
  display_name = "GitHub Actions Service Account"
  description  = "Service account for GitHub Actions CI/CD"
}

# Grant necessary permissions to the service account
resource "google_project_iam_member" "github_actions_roles" {
  for_each = toset([
    "roles/run.admin",               # Deploy to Cloud Run
    "roles/artifactregistry.writer", # Push Docker images
    "roles/storage.admin",           # Access storage buckets
    "roles/iam.serviceAccountUser",  # Act as service account
    "roles/pubsub.admin",            # Create Pub/Sub topics and subscriptions
    "roles/iam.serviceAccountAdmin", # Create service accounts
  ])

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

# Allow GitHub Actions to impersonate the service account
resource "google_service_account_iam_member" "workload_identity_binding" {
  service_account_id = google_service_account.github_actions.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_pool.name}/attribute.repository/${var.github_org}/${var.github_repo}"
}

# Create Artifact Registry repository for Docker images.
#
# NOTE: this declares the SAME repository as
# terraform/environments/prod/main.tf ("shorted" in australia-southeast2).
# This root module has no backend block, so it runs on local state and is
# bootstrap-only. The cleanup policies below are duplicated from the prod
# config on purpose: without them, applying this file would strip the
# retention rules off the live repository and let it grow without bound.
# Keep the two definitions in sync, or remove this resource once bootstrap no
# longer needs it.
resource "google_artifact_registry_repository" "docker_repo" {
  project       = var.project_id
  location      = "australia-southeast2"
  repository_id = "shorted"
  description   = "Docker repository for Shorted services"
  format        = "DOCKER"

  cleanup_policies {
    id     = "keep-recent-images"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s" # 7 days
    }
  }

  cleanup_policy_dry_run = false

  depends_on = [google_project_service.required_apis]
}

# Outputs for GitHub Actions configuration
output "workload_identity_provider" {
  description = "Workload Identity Provider for GitHub Actions"
  value       = google_iam_workload_identity_pool_provider.github_provider.name
}

output "service_account_email" {
  description = "Service Account email for GitHub Actions"
  value       = google_service_account.github_actions.email
}

output "artifact_registry_location" {
  description = "Artifact Registry location"
  value       = "${google_artifact_registry_repository.docker_repo.location}-docker.pkg.dev"
}

output "artifact_registry_repository" {
  description = "Full Artifact Registry repository path"
  value       = "${google_artifact_registry_repository.docker_repo.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker_repo.repository_id}"
}
