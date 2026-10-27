mock_provider "google" {
  override_during = plan
  mock_resource "google_service_account" {
    defaults = { email = "fixture@metrics-test.iam.gserviceaccount.com" }
  }
}
mock_provider "random" {}

override_resource {
  target = google_service_account.@ACCOUNT@
  override_during = plan
  values = { email = "selected-workload@metrics-test.iam.gserviceaccount.com" }
}

@VARIABLES@

run "disabled_by_default" {
  command = plan
  assert {
    condition = length([for e in @CONTAINER@.env : e if startswith(e.name, "OTEL_EXPORTER_OTLP_METRICS")]) == 0
    error_message = "Default configuration must not bind metrics routing or credentials."
  }
  assert {
    condition = length(google_secret_manager_secret_iam_member.@IAM@) == 0
    error_message = "Disabled metrics must grant no additional Secret Manager access."
  }
  assert {
    condition = one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_ENDPOINT"]).value == "https://traces.test/otlp"
    error_message = "Generic trace endpoint must remain unchanged."
  }
}

run "metrics_only_override" {
  command = plan
  variables {
    otel_metrics = { enabled = true, endpoint = "https://origin-vke.telesis.dev/v1/metrics", headers_secret = "TELESIS_OTLP_METRICS_HEADERS" }
  }
  assert {
    condition = one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"]).value == var.otel_metrics.endpoint
    error_message = "Metrics must use the separate complete signal URL."
  }
  assert {
    condition = one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL"]).value == "http/protobuf" && one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"]).value == "cumulative"
    error_message = "The metrics receiver requires HTTP/protobuf and cumulative streams."
  }
  assert {
    condition = one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_METRICS_HEADERS"]).value_source[0].secret_key_ref[0].secret == "TELESIS_OTLP_METRICS_HEADERS"
    error_message = "Metrics auth must come from the dedicated Secret Manager reference."
  }
  assert {
    condition = one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_HEADERS"]).value_source[0].secret_key_ref[0].secret == "OTEL_EXPORTER_OTLP_HEADERS"
    error_message = "Generic trace auth must remain separate."
  }
  assert {
    condition = one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_ENDPOINT"]).value == "https://traces.test/otlp"
    error_message = "Metrics enablement must not reroute traces."
  }
  assert {
    condition = google_secret_manager_secret_iam_member.@IAM@[0].secret_id == "TELESIS_OTLP_METRICS_HEADERS" && google_secret_manager_secret_iam_member.@IAM@[0].member == "serviceAccount:selected-workload@metrics-test.iam.gserviceaccount.com" && google_secret_manager_secret_iam_member.@IAM@[0].role == "roles/secretmanager.secretAccessor"
    error_message = "Grant access to only the configured metrics header secret."
  }
  assert {
    condition = output.non_metrics_env == run.disabled_by_default.non_metrics_env
    error_message = "Enabling metrics must leave every non-metrics environment setting unchanged."
  }

}

run "reject_missing_metrics_credentials" {
  command = plan
  variables {
    otel_metrics = { enabled = true, endpoint = "https://origin-vke.telesis.dev/v1/metrics" }
  }
  expect_failures = [var.otel_metrics]
}

run "reject_generic_grafana_credentials" {
  command = plan
  variables {
    otel_metrics = { enabled = true, endpoint = "https://origin-vke.telesis.dev/v1/metrics", headers_secret = "OTEL_EXPORTER_OTLP_HEADERS" }
  }
  expect_failures = [var.otel_metrics]
}
