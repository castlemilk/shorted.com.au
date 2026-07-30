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
  environment      = "dev"
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
    ENVIRONMENT                 = "dev"
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
}

# `shorted economy -mode all` — replaces module.economy_collector.
module "shorted_job_economy" {
  source = "../../modules/shorted-job"

  name             = "shorted-economy"
  description      = "Monthly ABS/RBA/DCCEEW economy ingest"
  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  # The OLD dev economy-collector was mislabelled "production" (pre-existing
  # quirk); the replacement is a fresh resource, so label it honestly.
  environment = "dev"
  image_url   = var.shorted_jobs_image

  args     = ["economy", "-mode", "all"]
  schedule = "0 17 5 * *" # 5th of month, 17:00 UTC (an hour after the housing job)

  env = {
    ENVIRONMENT = "dev"
    GCP_PROJECT = var.project_id
  }

  secret_env = {
    DATABASE_URL = "DATABASE_URL"
  }

  timeout_seconds = 1800
  cpu             = "1"
  memory          = "512Mi"
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
  # The OLD dev weekly-report-generator was mislabelled "production"
  # (pre-existing quirk, same as economy); the replacement is a fresh resource.
  environment = "dev"
  image_url   = var.shorted_jobs_image

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
    ENVIRONMENT                 = "dev"
    OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
  }

  # GEMINI_API_KEY is gated on the same var the old module used.
  secret_env = merge({
    DATABASE_URL               = "DATABASE_URL"
    OPENAI_API_KEY             = "OPENAI_API_KEY"
    OTEL_EXPORTER_OTLP_HEADERS = "OTEL_EXPORTER_OTLP_HEADERS"
    }, var.gemini_secret_exists ? {
    GEMINI_API_KEY = "GEMINI_API_KEY"
  } : {})

  timeout_seconds = 900 # same as the old module
  cpu             = "1"
  memory          = "512Mi"
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
  environment      = "dev"
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
    ENVIRONMENT                 = "dev"
    PUBLIC_SITE_URL             = "https://shorted.com.au"
    OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
  }

  # EMAIL_IMG_SECRET is NOT wired in dev — the old module's
  # email_img_secret_exists defaulted to false here.
  secret_env = merge({
    DATABASE_URL               = "DATABASE_URL"
    OTEL_EXPORTER_OTLP_HEADERS = "OTEL_EXPORTER_OTLP_HEADERS"
    }, var.gemini_secret_exists ? {
    GEMINI_API_KEY = "GEMINI_API_KEY"
  } : {})

  timeout_seconds            = 900 # same as the old module
  scheduler_attempt_deadline = "600s"
  cpu                        = "1"
  memory                     = "512Mi"
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
  environment      = "dev"
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
    ENVIRONMENT                 = "dev"
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
}

# Influence Collector Job (ATO tax / CER emissions / AusTender / AEC / lobbyists
# / trade). The APH register-of-interests crawl runs on the same job but is
# operator-invoked, never scheduled — see the module header.
#
# manage_register_bucket stays false here: the register crawl runs in prod, and
# dev has no need for a second copy of parliamentary PDFs. With REGISTER_BUCKET
# unset the collector falls back to a local directory, so an operator can still
# exercise the modes in dev without a bucket.
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
# Chat Service — NOT managed in dev. The image is now CI-built per commit. Dev
# remains deliberately unmanaged because chat is exercised in prod;
# re-managing it would require re-importing the state-rm'd service.
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

  # Jobs-monolith cutover (slice 3) — both surfaces now run the consolidated
  # `shorted` binary IN PLACE: the SAME Cloud Run service/job resources, the
  # same service accounts, the same schedulers, just a new image + args. The
  # binary's ENTRYPOINT is /shorted; command is set explicitly so the args are
  # unambiguous. ROLLBACK: delete these six lines (or set the two *_override
  # vars to "") and apply — the legacy images come straight back.
  market_data_sync_image_override = var.shorted_jobs_image
  market_data_sync_command        = ["/shorted"]
  market_data_sync_args           = ["market-data", "serve"]

  asx_discovery_image_override = var.shorted_jobs_browser_image
  asx_discovery_command        = ["/shorted"]
  asx_discovery_args           = ["discovery"]

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
  gemini_secret_exists = var.gemini_secret_exists
  scheduler_paused     = true

  depends_on = [
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
  environment      = "dev"
  image_url        = var.signals_collector_image
  scheduler_paused = true

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
