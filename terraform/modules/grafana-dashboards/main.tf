terraform {
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
  }
}

provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_auth
}

resource "grafana_folder" "shorted" {
  title = var.folder_title
}

resource "grafana_dashboard" "operations" {
  folder    = grafana_folder.shorted.id
  overwrite = true

  config_json = jsonencode({
    title       = "Shorted - Operations"
    description = "Operational dashboard for Shorted API and frontend"
    tags        = ["shorted", "operations"]
    timezone    = "browser"
    editable    = true
    time = {
      from = "now-6h"
      to   = "now"
    }
    refresh = "30s"

    templating = {
      list = [
        {
          name    = "service"
          type    = "custom"
          current = { text = "shorted-api", value = "shorted-api" }
          options = [
            { text = "shorted-api", value = "shorted-api", selected = true },
            { text = "shorted-market-data", value = "shorted-market-data", selected = false },
            { text = "shorted-web", value = "shorted-web", selected = false },
          ]
        }
      ]
    }

    panels = concat(
      # ───────────────────────────────────────────────────────────
      # Row: API Overview
      # ───────────────────────────────────────────────────────────
      [{
        type      = "row"
        title     = "API Overview"
        gridPos   = { h = 1, w = 24, x = 0, y = 0 }
        collapsed = false
      }],

      # Panel 1: RPC Request Rate (derived from otelconnect duration histogram count)
      [{
        type       = "timeseries"
        title      = "RPC Request Rate"
        gridPos    = { h = 8, w = 12, x = 0, y = 1 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "reqps"
            custom = { drawStyle = "line", fillOpacity = 10, lineWidth = 2 }
          }
        }
        targets = [{
          expr         = "sum(rate(rpc_server_duration_milliseconds_count{job=\"$service\"}[$__rate_interval])) by (rpc_method)"
          legendFormat = "{{ rpc_method }}"
          refId        = "A"
        }]
      }],

      # Panel 2: RPC Duration (p50, p95, p99)
      [{
        type       = "timeseries"
        title      = "RPC Duration (p50 / p95 / p99)"
        gridPos    = { h = 8, w = 12, x = 12, y = 1 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "ms"
            custom = { drawStyle = "line", fillOpacity = 5, lineWidth = 2 }
          }
        }
        targets = [
          {
            expr         = "histogram_quantile(0.50, sum(rate(rpc_server_duration_milliseconds_bucket{job=\"$service\"}[$__rate_interval])) by (le))"
            legendFormat = "p50"
            refId        = "A"
            exemplar     = true
          },
          {
            expr         = "histogram_quantile(0.95, sum(rate(rpc_server_duration_milliseconds_bucket{job=\"$service\"}[$__rate_interval])) by (le))"
            legendFormat = "p95"
            refId        = "B"
            exemplar     = true
          },
          {
            expr         = "histogram_quantile(0.99, sum(rate(rpc_server_duration_milliseconds_bucket{job=\"$service\"}[$__rate_interval])) by (le))"
            legendFormat = "p99"
            refId        = "C"
            exemplar     = true
          },
        ]
      }],

      # Panel 3: RPC Error Rate
      [{
        type       = "timeseries"
        title      = "RPC Error Rate"
        gridPos    = { h = 8, w = 8, x = 0, y = 9 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "reqps"
            custom = { drawStyle = "bars", fillOpacity = 50, lineWidth = 1 }
            color  = { mode = "fixed", fixedColor = "red" }
          }
        }
        targets = [{
          expr         = "sum(rate(rpc_server_duration_milliseconds_count{job=\"$service\", rpc_grpc_status_code!~\"0|OK\"}[$__rate_interval])) by (rpc_grpc_status_code)"
          legendFormat = "{{ rpc_grpc_status_code }}"
          refId        = "A"
        }]
      }],

      # Panel 4: RPC Duration by Method (p95)
      [{
        type       = "timeseries"
        title      = "RPC p95 by Method"
        gridPos    = { h = 8, w = 8, x = 8, y = 9 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "ms"
            custom = { drawStyle = "line", fillOpacity = 5, lineWidth = 1 }
          }
        }
        targets = [{
          expr         = "histogram_quantile(0.95, sum(rate(rpc_server_duration_milliseconds_bucket{job=\"$service\"}[$__rate_interval])) by (le, rpc_method))"
          legendFormat = "{{ rpc_method }}"
          refId        = "A"
          exemplar     = true
        }]
      }],

      # Panel 5: Request Count (stat)
      [{
        type       = "stat"
        title      = "Total Requests (24h)"
        gridPos    = { h = 4, w = 8, x = 16, y = 9 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit  = "short"
            color = { mode = "thresholds" }
            thresholds = { steps = [
              { color = "green", value = null },
              { color = "yellow", value = 10000 },
              { color = "red", value = 50000 },
            ] }
          }
        }
        options = { colorMode = "background" }
        targets = [{
          expr  = "sum(increase(rpc_server_duration_milliseconds_count{job=\"$service\"}[24h]))"
          refId = "A"
        }]
      }],

      # Panel 6: Error Count (stat)
      [{
        type       = "stat"
        title      = "Errors (24h)"
        gridPos    = { h = 4, w = 8, x = 16, y = 13 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit  = "short"
            color = { mode = "thresholds" }
            thresholds = { steps = [
              { color = "green", value = null },
              { color = "yellow", value = 100 },
              { color = "red", value = 500 },
            ] }
          }
        }
        options = { colorMode = "background" }
        targets = [{
          expr  = "sum(increase(rpc_server_duration_milliseconds_count{job=\"$service\", rpc_grpc_status_code!~\"0|OK\"}[24h]))"
          refId = "A"
        }]
      }],

      # ───────────────────────────────────────────────────────────
      # Row: Database Performance
      # ───────────────────────────────────────────────────────────
      [{
        type      = "row"
        title     = "Database Performance"
        gridPos   = { h = 1, w = 24, x = 0, y = 17 }
        collapsed = false
      }],

      # Panel: DB Connection Pool Utilization
      [{
        type       = "timeseries"
        title      = "DB Connection Pool"
        gridPos    = { h = 8, w = 12, x = 0, y = 18 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "short"
            custom = { drawStyle = "line", fillOpacity = 10, lineWidth = 2 }
          }
        }
        targets = [
          {
            expr         = "db_pool_active_connections{job=\"$service\"}"
            legendFormat = "Active"
            refId        = "A"
          },
          {
            expr         = "db_pool_idle_connections{job=\"$service\"}"
            legendFormat = "Idle"
            refId        = "B"
          },
          {
            expr         = "db_pool_total_connections{job=\"$service\"}"
            legendFormat = "Total"
            refId        = "C"
          },
          {
            expr         = "db_pool_max_connections{job=\"$service\"}"
            legendFormat = "Max"
            refId        = "D"
          },
        ]
      }],

      # Panel: DB Query Duration by Operation (from otelpgx spans via Tempo)
      [{
        type       = "timeseries"
        title      = "DB Pool Utilization %"
        gridPos    = { h = 8, w = 12, x = 12, y = 18 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "percentunit"
            min    = 0
            max    = 1
            custom = { drawStyle = "line", fillOpacity = 20, lineWidth = 2 }
            color  = { mode = "thresholds" }
            thresholds = { steps = [
              { color = "green", value = null },
              { color = "yellow", value = 0.7 },
              { color = "red", value = 0.9 },
            ] }
          }
        }
        targets = [{
          expr         = "db_pool_active_connections{job=\"$service\"} / db_pool_max_connections{job=\"$service\"}"
          legendFormat = "Pool Utilization"
          refId        = "A"
        }]
      }],

      # ───────────────────────────────────────────────────────────
      # Row: Security & Rate Limiting
      # ───────────────────────────────────────────────────────────
      [{
        type      = "row"
        title     = "Security & Rate Limiting"
        gridPos   = { h = 1, w = 24, x = 0, y = 26 }
        collapsed = false
      }],

      # Panel 7: Rate Limit Blocks
      [{
        type       = "timeseries"
        title      = "Rate Limit Blocks"
        gridPos    = { h = 8, w = 8, x = 0, y = 27 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "short"
            custom = { drawStyle = "bars", fillOpacity = 50, lineWidth = 1 }
            color  = { mode = "palette-classic" }
          }
        }
        targets = [{
          expr         = "sum(rate(shorted_rate_limit_blocked_total{job=\"shorted-api\"}[$__rate_interval])) by (tier)"
          legendFormat = "{{ tier }}"
          refId        = "A"
        }]
      }],

      # Panel 8: Scraper Blocks
      [{
        type       = "timeseries"
        title      = "Scraper / Bot Blocks"
        gridPos    = { h = 8, w = 8, x = 8, y = 27 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "short"
            custom = { drawStyle = "bars", fillOpacity = 50, lineWidth = 1 }
            color  = { mode = "palette-classic" }
          }
        }
        targets = [{
          expr         = "sum(rate(shorted_scraper_blocked_total{job=\"shorted-api\"}[$__rate_interval])) by (reason)"
          legendFormat = "{{ reason }}"
          refId        = "A"
        }]
      }],

      # Panel 9: Auth Method Distribution
      [{
        type       = "piechart"
        title      = "Auth Methods (24h)"
        gridPos    = { h = 8, w = 8, x = 16, y = 27 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        options = {
          reduceOptions = { calcs = ["sum"] }
          legend        = { displayMode = "table", placement = "right" }
        }
        targets = [{
          expr         = "sum(increase(shorted_auth_method_total{job=\"shorted-api\"}[24h])) by (method)"
          legendFormat = "{{ method }}"
          refId        = "A"
        }]
      }],

      # Panel 10: Rate Limit Blocks (24h stat)
      [{
        type       = "stat"
        title      = "Rate Limited (24h)"
        gridPos    = { h = 4, w = 6, x = 0, y = 35 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit  = "short"
            color = { mode = "thresholds" }
            thresholds = { steps = [
              { color = "green", value = null },
              { color = "yellow", value = 50 },
              { color = "red", value = 200 },
            ] }
          }
        }
        options = { colorMode = "background" }
        targets = [{
          expr  = "sum(increase(shorted_rate_limit_blocked_total{job=\"shorted-api\"}[24h]))"
          refId = "A"
        }]
      }],

      # Panel 11: Scrapers Blocked (24h stat)
      [{
        type       = "stat"
        title      = "Scrapers Blocked (24h)"
        gridPos    = { h = 4, w = 6, x = 6, y = 35 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit  = "short"
            color = { mode = "thresholds" }
            thresholds = { steps = [
              { color = "green", value = null },
              { color = "yellow", value = 20 },
              { color = "red", value = 100 },
            ] }
          }
        }
        options = { colorMode = "background" }
        targets = [{
          expr  = "sum(increase(shorted_scraper_blocked_total{job=\"shorted-api\"}[24h]))"
          refId = "A"
        }]
      }],

      # Panel 12: Anonymous vs Authenticated (24h)
      [{
        type       = "stat"
        title      = "Anonymous Requests (24h)"
        gridPos    = { h = 4, w = 6, x = 12, y = 35 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit  = "short"
            color = { mode = "fixed", fixedColor = "orange" }
          }
        }
        options = { colorMode = "background" }
        targets = [{
          expr  = "sum(increase(shorted_auth_method_total{job=\"shorted-api\", method=\"anonymous\"}[24h]))"
          refId = "A"
        }]
      }],

      # Panel 13: Authenticated Requests (24h)
      [{
        type       = "stat"
        title      = "Authenticated (24h)"
        gridPos    = { h = 4, w = 6, x = 18, y = 35 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit  = "short"
            color = { mode = "fixed", fixedColor = "green" }
          }
        }
        options = { colorMode = "background" }
        targets = [{
          expr  = "sum(increase(shorted_auth_method_total{job=\"shorted-api\", method!=\"anonymous\"}[24h]))"
          refId = "A"
        }]
      }],

      # ───────────────────────────────────────────────────────────
      # Row: Sync Jobs
      # ───────────────────────────────────────────────────────────
      [{
        type      = "row"
        title     = "Sync Jobs"
        gridPos   = { h = 1, w = 24, x = 0, y = 39 }
        collapsed = false
      }],

      # Panel: Sync Job Duration
      [{
        type       = "timeseries"
        title      = "Sync Job Duration"
        gridPos    = { h = 8, w = 12, x = 0, y = 40 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "s"
            custom = { drawStyle = "bars", fillOpacity = 30, lineWidth = 1 }
            color  = { mode = "palette-classic" }
          }
        }
        targets = [{
          expr         = "histogram_quantile(0.95, sum(rate(shorted_sync_duration_seconds_bucket[$__rate_interval])) by (le, job))"
          legendFormat = "{{ job }} p95"
          refId        = "A"
          exemplar     = true
        }]
      }],

      # Panel: Sync Records Processed
      [{
        type       = "timeseries"
        title      = "Sync Records Processed"
        gridPos    = { h = 8, w = 12, x = 12, y = 40 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "short"
            custom = { drawStyle = "bars", fillOpacity = 50, lineWidth = 1 }
            color  = { mode = "palette-classic" }
          }
        }
        targets = [{
          expr         = "sum(increase(shorted_sync_records_processed_total[$__rate_interval])) by (type)"
          legendFormat = "{{ type }}"
          refId        = "A"
        }]
      }],

      # Panel: Last Successful Sync
      [{
        type       = "stat"
        title      = "Last Successful Sync"
        gridPos    = { h = 4, w = 8, x = 0, y = 48 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit  = "dateTimeFromNow"
            color = { mode = "thresholds" }
            thresholds = { steps = [
              { color = "green", value = null },
              { color = "yellow", value = 90000 },
              { color = "red", value = 172800 },
            ] }
          }
        }
        options = { colorMode = "background" }
        targets = [{
          expr  = "shorted_sync_last_success{job=\"shorted-market-data-sync\"} * 1000"
          refId = "A"
        }]
      }],

      # Panel: Sync Success Rate
      [{
        type       = "stat"
        title      = "Sync Success (24h)"
        gridPos    = { h = 4, w = 8, x = 8, y = 48 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit  = "short"
            color = { mode = "fixed", fixedColor = "green" }
          }
        }
        options = { colorMode = "background" }
        targets = [{
          expr  = "sum(increase(shorted_sync_status_total{status=\"success\"}[24h]))"
          refId = "A"
        }]
      }],

      # Panel: Sync Failure Count
      [{
        type       = "stat"
        title      = "Sync Failures (24h)"
        gridPos    = { h = 4, w = 8, x = 16, y = 48 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit  = "short"
            color = { mode = "thresholds" }
            thresholds = { steps = [
              { color = "green", value = null },
              { color = "yellow", value = 1 },
              { color = "red", value = 3 },
            ] }
          }
        }
        options = { colorMode = "background" }
        targets = [{
          expr  = "sum(increase(shorted_sync_status_total{status=\"failure\"}[24h]))"
          refId = "A"
        }]
      }],

      # ───────────────────────────────────────────────────────────
      # Row: Frontend (Next.js)
      # ───────────────────────────────────────────────────────────
      [{
        type      = "row"
        title     = "Frontend (Next.js)"
        gridPos   = { h = 1, w = 24, x = 0, y = 52 }
        collapsed = false
      }],

      # Panel 14: Frontend Server Action Duration
      [{
        type       = "timeseries"
        title      = "Server Action Duration (p95)"
        gridPos    = { h = 8, w = 12, x = 0, y = 53 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "ms"
            custom = { drawStyle = "line", fillOpacity = 10, lineWidth = 2 }
          }
        }
        targets = [{
          expr         = "histogram_quantile(0.95, sum(rate(http_server_duration_milliseconds_bucket{job=\"shorted-web\"}[$__rate_interval])) by (le, http_route))"
          legendFormat = "{{ http_route }}"
          refId        = "A"
        }]
      }],

      # Panel 15: Frontend Request Rate
      [{
        type       = "timeseries"
        title      = "Frontend Request Rate"
        gridPos    = { h = 8, w = 12, x = 12, y = 53 }
        datasource = { type = "prometheus", uid = var.prometheus_datasource_uid }
        fieldConfig = {
          defaults = {
            unit   = "reqps"
            custom = { drawStyle = "line", fillOpacity = 10, lineWidth = 2 }
          }
        }
        targets = [{
          expr         = "sum(rate(http_server_duration_milliseconds_count{job=\"shorted-web\"}[$__rate_interval])) by (http_route)"
          legendFormat = "{{ http_route }}"
          refId        = "A"
        }]
      }],
    )
  })
}
