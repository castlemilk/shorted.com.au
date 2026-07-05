/**
 * Chat Service Module
 *
 * Manages:
 * - Cloud Run service for the AI Chat Service (Go service with Gemini)
 * - Service account and IAM permissions
 * - Database and API key configuration
 */

locals {
  service_name = "chat-service"
  labels = {
    service     = "chat-service"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Service Account for the Cloud Run service
resource "google_service_account" "chat_service" {
  account_id   = local.service_name
  display_name = "Chat Service"
  description  = "Service account for the AI Chat Service"
  project      = var.project_id
}

# Grant Secret Manager access to service account
resource "google_secret_manager_secret_iam_member" "postgres_password" {
  secret_id = "APP_STORE_POSTGRES_PASSWORD"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.chat_service.email}"
  project   = var.project_id
}

# Grant access to Gemini API key
resource "google_secret_manager_secret_iam_member" "gemini_api_key" {
  secret_id = "GEMINI_API_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.chat_service.email}"
  project   = var.project_id
}

resource "google_secret_manager_secret_iam_member" "otel_headers" {
  secret_id = "OTEL_EXPORTER_OTLP_HEADERS"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.chat_service.email}"
  project   = var.project_id
}

# Cloud Run Service
resource "google_cloud_run_v2_service" "chat_service" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    service_account                  = google_service_account.chat_service.email
    max_instance_request_concurrency = var.max_instance_request_concurrency

    containers {
      image = var.image_url

      ports {
        container_port = 8080
        name           = "http1"
      }

      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }

      env {
        name  = "APP_STORE_POSTGRES_ADDRESS"
        value = var.postgres_address
      }

      env {
        name  = "APP_STORE_POSTGRES_DATABASE"
        value = var.postgres_database
      }

      env {
        name  = "APP_STORE_POSTGRES_USERNAME"
        value = var.postgres_username
      }

      env {
        name = "APP_STORE_POSTGRES_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = "APP_STORE_POSTGRES_PASSWORD"
            version = "latest"
          }
        }
      }

      env {
        name = "GEMINI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = "GEMINI_API_KEY"
            version = "latest"
          }
        }
      }

      env {
        name  = "SHORTS_API_URL"
        value = var.shorts_api_url
      }

      env {
        name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
        value = var.otel_endpoint
      }

      env {
        name  = "OTEL_EXPORTER_OTLP_PROTOCOL"
        value = "http/protobuf"
      }

      env {
        name = "OTEL_EXPORTER_OTLP_HEADERS"
        value_source {
          secret_key_ref {
            secret  = "OTEL_EXPORTER_OTLP_HEADERS"
            version = "latest"
          }
        }
      }

      env {
        name  = "GEMINI_MAX_OUTPUT_TOKENS"
        value = tostring(var.gemini_max_output_tokens)
      }

      env {
        name  = "CHAT_MAX_INPUT_CHARS"
        value = tostring(var.chat_max_input_chars)
      }

      env {
        name  = "CHAT_HISTORY_LIMIT"
        value = tostring(var.chat_history_limit)
      }

      env {
        name  = "CHAT_MAX_MESSAGES_PER_CONVERSATION"
        value = tostring(var.chat_max_messages_per_conversation)
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        timeout_seconds       = 3
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 30
        period_seconds        = 30
        timeout_seconds       = 5
        failure_threshold     = 3
      }
    }

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    timeout = "120s"
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_secret_manager_secret_iam_member.postgres_password,
    google_secret_manager_secret_iam_member.gemini_api_key,
    google_secret_manager_secret_iam_member.otel_headers
  ]
}

# Allow public access (fronted by Next.js rewrite)
resource "google_cloud_run_v2_service_iam_member" "public_access" {
  name     = google_cloud_run_v2_service.chat_service.name
  location = google_cloud_run_v2_service.chat_service.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}
