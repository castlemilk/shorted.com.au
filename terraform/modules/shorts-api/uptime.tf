# Off-cluster availability checks for the API. They run on Google's checkers,
# so they still report when the cluster, Telesis or the deploy tooling is down
# (see docs/PRODUCTION_DEPLOYMENT.md, "Uptime checks").
#
# Two checks:
#  (a) the public origin the browsers and the MCP clients use:
#      api.shorted.com.au, a real Connect call (GetTopShorts, limit 1), every 5 min.
#  (b) the Cloud Run origin behind it, /health, every 1 min.
# An alert fires when a check fails from at least two checker regions for 5 min.
#
# api.shorted.com.au sits behind Cloudflare. Its edge worker limits anonymous
# callers to 10 requests per 10 s per IP, and bot management may challenge
# Google's checkers. A challenge fails check (a) (it is not a 200 with the body),
# and that is the signal to read first, not a reason to add a WAF bypass here.

locals {
  uptime_host_public = "api.shorted.com.au"
  uptime_host_run    = trimprefix(google_cloud_run_v2_service.shorts_api.uri, "https://")
}

resource "google_monitoring_uptime_check_config" "api_public" {
  project      = var.project_id
  display_name = "shorts API (api.shorted.com.au GetTopShorts)"
  timeout      = "10s"
  period       = "300s"

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.uptime_host_public
    }
  }

  http_check {
    path                = "/shorts.v1alpha1.MarketService/GetTopShorts"
    port                = 443
    use_ssl             = true
    validate_ssl        = true
    request_method      = "POST"
    content_type        = "USER_PROVIDED"
    custom_content_type = "application/json"
    # {"limit":1}
    body = base64encode("{\"limit\":1}")

    accepted_response_status_codes {
      status_value = 200
    }
  }

  # The response is a JSON message with a time_series list. protojson omits an
  # empty list, so this matches only a response that carries data.
  content_matchers {
    content = "\"timeSeries\""
    matcher = "CONTAINS_STRING"
  }
}

resource "google_monitoring_uptime_check_config" "run_health" {
  project      = var.project_id
  display_name = "shorts API (Cloud Run /health)"
  timeout      = "10s"
  period       = "60s"

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.uptime_host_run
    }
  }

  http_check {
    path           = "/health"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"

    accepted_response_status_codes {
      status_value = 200
    }
  }

  content_matchers {
    content = "OK"
    matcher = "CONTAINS_STRING"
  }
}

resource "google_monitoring_alert_policy" "api_public_down" {
  project      = var.project_id
  display_name = "shorts API down: api.shorted.com.au (GetTopShorts)"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "GetTopShorts check failing from 2+ regions for 5 min"

    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.api_public.uptime_check_id}\" AND resource.type=\"uptime_url\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 1

      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  documentation {
    content   = "Runbook: find which answered. Repeat the check's request as in docs/PRODUCTION_DEPLOYMENT.md (Uptime checks), with the checker's User-Agent, and read X-Shorted-Cache before X-Shorted-Build. HOT, HIT or KV is an edge copy with no build header: a cached {} means check mv_top_shorts. BYPASS or MISS with no X-Shorted-Build is Cloud Run's front end (crash, memory-limit kill, no instance): read the shorts service's logs. X-Shorted-Build present is the app: a 5xx means the logs and the database, and /health can pass while this check fails. A JSON 403 permission_denied (automated access detected) is the API's user-agent filter. A 429 with X-RateLimit-Detail is the app limiter; with X-RateLimit-Bucket it is the edge worker. A 524 is Cloudflare's origin timeout. No X-Shorted-Cache with a cf-mitigated header or a 'Just a moment' page is a Cloudflare challenge or zone rule. If a deploy just landed, roll back (docs/PRODUCTION_DEPLOYMENT.md, Rollback)."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "run_health_down" {
  project      = var.project_id
  display_name = "shorts API down: Cloud Run /health"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "/health check failing from 2+ regions for 5 min"

    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.run_health.uptime_check_id}\" AND resource.type=\"uptime_url\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 1

      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  documentation {
    content   = "Runbook: the Cloud Run service is not answering /health from two regions. Describe the shorts service (latest revision, ready condition), then its logs for memory-limit kills and startup errors. A response without X-Shorted-Build came from in front of Cloud Run, not the service. If a deploy just landed, roll back (docs/PRODUCTION_DEPLOYMENT.md, Rollback)."
    mime_type = "text/markdown"
  }
}

# The alerts' only notification target is the job-monitoring email channel,
# which exists only when alert_recipient_email is set. Without it the policies
# keep evaluating and notify no one, so say so at every production plan. Only
# production: `terraform test` plans the module with environment "test" and no
# channel (terraform/tests/metrics-routing), and a failed check fails a test.
check "uptime_alert_channel" {
  assert {
    condition     = var.environment != "production" || length(var.notification_channel_ids) > 0
    error_message = "The shorts API uptime alerts have no notification channel, so they evaluate and email no one. Set alert_recipient_email for prod (the job-monitoring email channel)."
  }
}
