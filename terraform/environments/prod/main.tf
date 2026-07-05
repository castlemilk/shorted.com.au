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
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.19"
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

provider "cloudflare" {
  # Prefer the scoped API Token (set CLOUDFLARE_API_TOKEN env var or
  # var.cloudflare_api_token). Fall back to legacy api_key + email when
  # neither is provided — keeps existing local-dev tfvars working.
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : null
  api_key   = var.cloudflare_api_token == "" && var.cloudflare_global_api_key != "" ? var.cloudflare_global_api_key : null
  email     = var.cloudflare_api_token == "" && var.cloudflare_email != "" ? var.cloudflare_email : null
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
    "monitoring.googleapis.com",
    "logging.googleapis.com",
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

  labels = {
    environment = "prod"
    managed_by  = "terraform"
  }

  cleanup_policies {
    id     = "keep-recent-images"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policy_dry_run = false

  depends_on = [time_sleep.wait_for_apis]
}

# Stock Price Ingestion Service
module "stock_price_ingestion" {
  source = "../../modules/stock-price-ingestion"

  project_id       = var.project_id
  region           = "us-central1"          # Tier 1 pricing — batch job, latency irrelevant
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
  # REVALIDATION_SECRET now exists in prod Secret Manager + the matching value
  # is set in the Vercel frontend env, so enable event-driven cache busting.
  manage_revalidation_secret = true

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
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
  max_instances     = 25
  postgres_address  = var.postgres_address
  postgres_database = var.postgres_database
  postgres_username = var.postgres_username

  scheduler_region             = "australia-southeast1"
  enable_key_metrics_scheduler = true

  # Operator email on each newsletter subscribe — RESEND_API_KEY secret is
  # provisioned in prod, so bind it (from/to default to support@shorted.com.au).
  resend_secret_exists = true

  # Unsubscribe HMAC secret for broadcast emails — provisioned in prod Secret Manager.
  unsubscribe_secret_exists = true

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# Reconcile pre-existing project-level IAM grants for the shorts SA into state.
# These bindings (run.viewer + cloudscheduler.viewer, added in #206 so the
# /api/admin/jobs endpoint can read Cloud Run executions + schedulers) already
# exist in prod (granted out-of-band). The CI deploy SA can getIamPolicy (read)
# but not setIamPolicy (write) at the project level, so a plain create 403s.
# Importing reconciles state without a write — after this applies once, there
# is no diff and the apply stays green. (import blocks are inert once in state.)
import {
  to = module.shorts_api.google_project_iam_member.shorts_api_run_viewer
  id = "rosy-clover-477102-t5 roles/run.viewer serviceAccount:shorts@rosy-clover-477102-t5.iam.gserviceaccount.com"
}

import {
  to = module.shorts_api.google_project_iam_member.shorts_api_scheduler_viewer
  id = "rosy-clover-477102-t5 roles/cloudscheduler.viewer serviceAccount:shorts@rosy-clover-477102-t5.iam.gserviceaccount.com"
}

# Enrichment Processor Service
module "enrichment_processor" {
  source = "../../modules/enrichment-processor"

  project_id        = var.project_id
  region            = "us-central1" # Tier 1 pricing — batch job, latency irrelevant
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

  project_id           = var.project_id
  region               = var.region
  scheduler_region     = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment          = "production"
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

# Chat Service (Connect-RPC AI chat, port 8080)
module "chat_service" {
  source = "../../modules/chat-service"

  project_id                       = var.project_id
  region                           = var.region
  environment                      = "production"
  image_url                        = var.chat_service_image
  min_instances                    = 0
  max_instances                    = 5
  max_instance_request_concurrency = 8

  postgres_address  = var.postgres_address
  postgres_database = var.postgres_database
  postgres_username = var.postgres_username

  # Route chat tool calls through the Cloudflare Worker so repeated read tools
  # benefit from edge cache rather than always hitting the Shorts API origin.
  shorts_api_url = "https://api.shorted.com.au"

  gemini_max_output_tokens           = 1024
  chat_max_input_chars               = 2000
  chat_history_limit                 = 20
  chat_max_messages_per_conversation = 100

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# Market Discovery and Data Sync Jobs
module "market_discovery_sync" {
  source = "../../modules/market-discovery-sync"

  project_id             = var.project_id
  region                 = "us-central1"          # Tier 1 pricing — batch job, latency irrelevant
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

  project_id           = var.project_id
  region               = var.region
  scheduler_region     = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment          = "production"
  image_url            = var.news_aggregator_image
  gemini_secret_exists = true
  # EMAIL_IMG_SECRET must be provisioned in Secret Manager BEFORE this is applied
  # (push-to-main = prod CD). The same value must also be set as a Vercel env var
  # so /api/email/img can verify the digest's signed thumbnail URLs.
  email_img_secret_exists = true
  public_site_url         = "https://shorted.com.au"

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

# Signals collector — brandbrain risk/reputation signals (§6.9). Scale-to-zero job.
module "signals_collector" {
  source = "../../modules/signals-collector"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1"
  environment      = "production"
  image_url        = var.signals_collector_image

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# Report extractor — director-trade + financial-report digest jobs (§6.9). Scale-to-zero.
# gemini_secret_exists=true: the GEMINI_API_KEY secret IS provisioned in prod (enabled
# version 1, also used by news-aggregator + chat-service). Without it both jobs exit(1)
# on startup (director) / silently produce zero digests (financial), so it must be wired.
module "report_extractor" {
  source = "../../modules/report-extractor"

  project_id           = var.project_id
  region               = var.region
  scheduler_region     = "australia-southeast1"
  environment          = "production"
  image_url            = var.report_extractor_image
  gemini_secret_exists = true

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# =============================================================================
# Observability — Cloud Monitoring alerting on Cloud Run Job failures
# =============================================================================
# GCP-native, free, no DB dependency. Pages on hard execution failures AND on
# ERROR-log / timeout terminations (the "exit 0 but did nothing" class, e.g. the
# short-data-sync uvicorn-zombie). No-op until alert_recipient_email is set.
module "job_monitoring" {
  source = "../../modules/job-monitoring"

  project_id            = var.project_id
  alert_recipient_email = var.alert_recipient_email

  depends_on = [google_project_service.required_apis]
}

# =============================================================================
# Cloudflare Edge — CDN, WAF, rate limiting, DNS
# =============================================================================

module "edge" {
  source = "../../modules/cloudflare-edge"

  cloudflare_zone_id = var.cloudflare_zone_id
  domain             = "api.shorted.com.au"
  environment        = "production"

  shorts_api_origin       = module.shorts_api.service_url
  chat_service_origin     = module.chat_service.service_url
  market_data_origin      = module.market_data.service_url
  frontend_origin         = "https://shorted.com.au"
  create_frontend_records = true # Proxy frontend through Cloudflare edge for caching + rate limiting

  # AI crawler policy: allow AI bots (llms.txt / Content-Signals / MCP
  # discovery strategy). Token re-scoped with Bot Management Edit June 2026.
  manage_ai_crawler_settings = true
  ai_bots_protection         = "disabled"
  markdown_for_agents        = "on"

  # DNS hardening — SPF (Google Workspace) + DMARC (p=none monitor) + DNSSEC
  # signing. DNSSEC is not enforced until the DS record (edge_dnssec_ds_record
  # output) is published at the .com.au registrar.
  dns_security_enabled = true
  manage_dnssec        = true

  cache_ttl_seconds    = 60
  top_shorts_cache_ttl = 300
  stock_data_cache_ttl = 120
  news_cache_ttl       = 300

  rate_limit_enabled         = true
  api_rate_limit_requests    = 60
  search_rate_limit_requests = 20

  rate_limit_testing_bypass_secret      = var.rate_limit_testing_bypass_secret
  rate_limit_testing_bypass_header_name = var.rate_limit_testing_bypass_header_name
  rate_limit_testing_bypass_user_agent  = var.rate_limit_testing_bypass_user_agent

  waf_enabled            = true
  bot_protection_enabled = true

  cache_purge_secret = var.cache_purge_secret
  prewarm_secret     = var.cache_purge_secret # reuse same shared secret for both worker bindings
}

output "edge_url" {
  description = "Edge-proxied URL for the API."
  value       = "https://api.shorted.com.au"
}

output "edge_worker_name" {
  description = "Name of the Cloudflare edge worker."
  value       = module.edge.worker_name
}

output "edge_dnssec_ds_record" {
  description = "DNSSEC DS record to publish at the .com.au registrar to activate DNSSEC. Run: terraform output -raw edge_dnssec_ds_record"
  value       = module.edge.dnssec_ds_record
}
