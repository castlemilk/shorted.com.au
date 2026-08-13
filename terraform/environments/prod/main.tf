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

  project_id            = var.project_id
  region                = var.region
  scheduler_region      = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment           = "production"
  image_url             = var.house_price_collector_image
  official_max_failures = var.house_price_collector_official_max_failures
  # REVALIDATION_SECRET exists in prod Secret Manager (shared with short-data-sync)
  # + the matching value is set in the Vercel frontend env, so enable event-driven
  # housing cache busting after a crawl-driven MV refresh.
  manage_revalidation_secret = true

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# ---------------------------------------------------------------------------
# Consolidated `shorted <job>` binary (services/jobs) — Phase 2 cutover.
# One image, one generic module, args select the subcommand.
# ---------------------------------------------------------------------------

# `shorted announcements ...` — replaces module.asx_announcement_crawler.
module "shorted_job_announcements" {
  source = "../../modules/shorted-job"

  name             = "shorted-announcements"
  description      = "Daily crawl of ASX announcements for director trades, dividends, and news"
  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url        = var.shorted_jobs_image

  # Identical to the old module's container args, prefixed with the subcommand.
  args = [
    "announcements",
    "-director-trades",
    "-dividends",
    "-news-table",
    "-all-announcements",
    "-years", "2024,2025,2026",
    "-workers", "6",
  ]

  schedule = "0 11 * * *" # 11 AM UTC = 9 PM AEST

  env = {
    ENVIRONMENT                 = "production"
    OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
  }

  secret_env = {
    DATABASE_URL               = "DATABASE_URL"
    OTEL_EXPORTER_OTLP_HEADERS = "OTEL_EXPORTER_OTLP_HEADERS"
  }

  timeout_seconds = 5400 # 90 min cap, same as the old module
  cpu             = "2"
  memory          = "1Gi"

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# `shorted economy -mode all` — replaces module.economy_collector.
module "shorted_job_economy" {
  source = "../../modules/shorted-job"

  name             = "shorted-economy"
  description      = "Monthly ABS/RBA/DCCEEW economy ingest"
  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url        = var.shorted_jobs_image

  args     = ["economy", "-mode", "all"]
  schedule = "0 17 5 * *" # 5th of month, 17:00 UTC (an hour after the housing job)

  env = {
    ENVIRONMENT = "production"
    GCP_PROJECT = var.project_id
  }

  secret_env = {
    DATABASE_URL = "DATABASE_URL"
  }

  timeout_seconds = 1800
  cpu             = "1"
  memory          = "512Mi"

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# `shorted weekly-report` — replaces module.weekly_report_generator.
# Two schedules on one job, exactly as before: weekly (no override) + monthly
# (REPORT_TYPE=monthly via container_overrides). The ported job resolves the
# cadence from -report-type OR $REPORT_TYPE, so the env override is carried over
# byte-for-byte from the old scheduler body.
module "shorted_job_weekly_report" {
  source = "../../modules/shorted-job"

  name             = "shorted-weekly-report"
  description      = "Weekly generation of short selling report with LLM narrative"
  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url        = var.shorted_jobs_image

  args     = ["weekly-report"]
  schedule = "0 11 * * 5" # Friday 11 AM UTC = 9 PM AEST

  schedules = [
    {
      name_suffix      = "monthly"
      cron             = "0 1 1 * *" # 1 AM UTC on the 1st (~11 AM AEST)
      description      = "Monthly generation of short selling report — auto-detects previous month"
      attempt_deadline = "1800s"
      env_override     = { REPORT_TYPE = "monthly" }
    },
  ]

  env = {
    ENVIRONMENT                 = "production"
    OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
  }

  # GEMINI_API_KEY exists in prod Secret Manager (the old call site passed
  # gemini_secret_exists = true).
  secret_env = {
    DATABASE_URL               = "DATABASE_URL"
    OPENAI_API_KEY             = "OPENAI_API_KEY"
    GEMINI_API_KEY             = "GEMINI_API_KEY"
    OTEL_EXPORTER_OTLP_HEADERS = "OTEL_EXPORTER_OTLP_HEADERS"
  }

  timeout_seconds = 900 # same as the old module
  cpu             = "1"
  memory          = "512Mi"

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# `shorted news` — replaces module.news_aggregator.
# ONE Cloud Run Job, FIVE schedules (identical topology to the old module): the
# primary aggregate run plus four RUN_MODE overrides. The ported job defaults
# its -run-mode flag from $RUN_MODE, so the old scheduler bodies carry over
# unchanged.
module "shorted_job_news" {
  source = "../../modules/shorted-job"

  name             = "shorted-news"
  description      = "Aggregate news from RSS feeds every 4 hours"
  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url        = var.shorted_jobs_image

  args     = ["news"]
  schedule = "0 */4 * * *" # every 4 hours

  schedules = [
    {
      name_suffix      = "backfill-images"
      cron             = "0 3 * * *"
      description      = "Daily og:image backfill for news_articles rows missing image_url"
      attempt_deadline = "1800s"
      env_override = {
        RUN_MODE             = "backfill-images"
        BACKFILL_LIMIT       = "2000"
        BACKFILL_CONCURRENCY = "6"
      }
    },
    {
      name_suffix      = "resolve-googlenews"
      cron             = "0 4 * * 1"
      description      = "Weekly resolver: follow googlenews redirects to publisher articles and scrape og:image"
      attempt_deadline = "1800s"
      env_override = {
        RUN_MODE             = "resolve-googlenews"
        BACKFILL_LIMIT       = "1000"
        BACKFILL_CONCURRENCY = "4"
        BACKFILL_UPDATE_URL  = "true"
      }
    },
    {
      name_suffix      = "cluster"
      cron             = "30 */2 * * *"
      description      = "Cluster duplicate-event news coverage into shared cluster_id groups"
      attempt_deadline = "600s"
      env_override = {
        RUN_MODE               = "cluster-news"
        CLUSTER_LOOKBACK_HOURS = "48"
        CLUSTER_MIN_OVERLAP    = "3"
      }
    },
    {
      name_suffix      = "digest"
      cron             = "0 1 * * 5"
      description      = "Weekly news digest: assemble draft broadcast for the current ISO week"
      attempt_deadline = "600s"
      env_override     = { RUN_MODE = "digest" }
    },
  ]

  env = {
    ENVIRONMENT                 = "production"
    PUBLIC_SITE_URL             = "https://shorted.com.au"
    OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
  }

  # News uses its OWN Gemini key secret (GEMINI_API_KEY_NEWS) — same mapping the
  # old module got from gemini_secret_name. EMAIL_IMG_SECRET must exist in
  # Secret Manager (it does: the old call site set email_img_secret_exists=true)
  # and must match the Vercel env var so /api/email/img verifies digest
  # thumbnail signatures.
  secret_env = {
    DATABASE_URL               = "DATABASE_URL"
    GEMINI_API_KEY             = "GEMINI_API_KEY_NEWS"
    EMAIL_IMG_SECRET           = "EMAIL_IMG_SECRET"
    OTEL_EXPORTER_OTLP_HEADERS = "OTEL_EXPORTER_OTLP_HEADERS"
  }

  timeout_seconds            = 900 # same as the old module
  scheduler_attempt_deadline = "600s"
  cpu                        = "1"
  memory                     = "512Mi"

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# `shorted signals` — replaces module.signals_collector.
# workers=2: brandbrain single-instance 502s above ~2 concurrent grounded calls.
module "shorted_job_signals" {
  source = "../../modules/shorted-job"

  name             = "shorted-signals"
  description      = "Weekly sweep of risk/reputation signals for top-shorted stocks via brandbrain"
  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1"
  environment      = "production"
  image_url        = var.shorted_jobs_image

  args = [
    "signals",
    "--priority", "top-shorted",
    "--limit", "200",
    "--max-age-days", "30",
    "--workers", "2",
  ]

  schedule = "0 13 * * 1" # Mondays 13:00 UTC (11 PM AEST)

  env = {
    ENVIRONMENT                 = "production"
    BRANDBRAIN_URL              = "https://api.brandbrain.dev"
    OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
  }

  secret_env = {
    DATABASE_URL               = "DATABASE_URL"
    OTEL_EXPORTER_OTLP_HEADERS = "OTEL_EXPORTER_OTLP_HEADERS"
  }

  timeout_seconds = 3600 # 1 hour, same as the old module
  cpu             = "1"
  memory          = "512Mi"

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
}

# Influence Collector Job (ATO tax / CER emissions / AusTender / AEC / lobbyists
# / trade). The APH register-of-interests crawl runs on the same job but is
# operator-invoked, never scheduled — see the module header.
module "influence_collector" {
  source = "../../modules/influence-collector"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  # The consolidated `shorted <job>` image: main's jobs consolidation retired the
  # standalone influence-collector image and CI no longer builds it. The module
  # passes the `influence` subcommand in its args.
  image_url = var.shorted_jobs_image

  # Prod is where the register crawl actually runs, so it owns the private PDF
  # bucket. report-extractor's SA is granted read HERE, not from that module:
  # binding IAM on another module's bucket produced the getIamPolicy 403 its
  # `removed {}` block documents.
  manage_register_bucket  = true
  reader_service_accounts = [module.report_extractor.service_account_email]

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

# Weekly Report Generator Job
#
# SUPERSEDED by module.shorted_job_weekly_report (`shorted weekly-report`).
# The job stays deployed + manually executable; only its two schedulers are
# paused until the replacement has one green scheduled run. Rollback: set
# scheduler_paused = false here and paused = true on shorted_job_weekly_report.
module "weekly_report_generator" {
  source = "../../modules/weekly-report-generator"

  project_id           = var.project_id
  region               = var.region
  scheduler_region     = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment          = "production"
  image_url            = var.weekly_report_generator_image
  gemini_secret_exists = true # GEMINI_API_KEY exists in Secret Manager (latest rotated 2026-07-11)
  scheduler_paused     = true

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

  gemini_secret_name                 = "GEMINI_API_KEY_CHAT"
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

  # Jobs-monolith cutover (slice 3) — both surfaces now run the consolidated
  # `shorted` binary IN PLACE: the SAME Cloud Run service/job resources, the
  # same service accounts, the same schedulers, just a new image + args. The
  # binary's ENTRYPOINT is /shorted; command is set explicitly so the args are
  # unambiguous. ROLLBACK: delete these six lines (or set the two *_override
  # vars to "") and apply — the legacy images come straight back. For the
  # service, `gcloud run services update-traffic market-data-sync
  # --to-revisions=<previous>=100 --region us-central1` is the instant path.
  market_data_sync_image_override = var.shorted_jobs_image
  market_data_sync_command        = ["/shorted"]
  market_data_sync_args           = ["market-data", "serve"]

  asx_discovery_image_override = var.shorted_jobs_browser_image
  asx_discovery_command        = ["/shorted"]
  asx_discovery_args           = ["discovery"]

  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted,
    module.short_data_sync
  ]
}

# Signals collector — brandbrain risk/reputation signals (§6.9). Scale-to-zero job.
#
# SUPERSEDED by module.shorted_job_signals (`shorted signals ...`). The job stays
# deployed + manually executable; only its scheduler is paused until the
# replacement has one green scheduled run. Rollback: set scheduler_paused = false
# here and paused = true on shorted_job_signals.
module "signals_collector" {
  source = "../../modules/signals-collector"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1"
  environment      = "production"
  image_url        = var.signals_collector_image
  scheduler_paused = true

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
  gemini_secret_name   = "GEMINI_API_KEY_REPORT_EXTRACTOR"
  director_limit       = 20
  reports_limit        = 10

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
  manage_ai_crawler_settings    = true
  ai_bots_protection            = "disabled"
  javascript_detections_enabled = false
  markdown_for_agents           = "on"

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
