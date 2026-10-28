mock_provider "google" {
  override_during = plan
  mock_resource "google_service_account" {
    defaults = { email = "fixture@metrics-test.iam.gserviceaccount.com" }
  }
}
mock_provider "random" {}

@VARIABLES@

run "production_metrics_profile" {
  command = plan
  # otel_metrics is loaded by -var-file from the actual non-secret prod
  # profile. A rollback to enabled=false is valid and must remove the override.
  assert {
    condition = var.otel_metrics.enabled ? (
      length([for e in @CONTAINER@.env : e if startswith(e.name, "OTEL_EXPORTER_OTLP_METRICS")]) == 4 &&
      one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"]).value == var.otel_metrics.endpoint &&
      one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_METRICS_HEADERS"]).value_source[0].secret_key_ref[0].secret == var.otel_metrics.headers_secret
    ) : length([for e in @CONTAINER@.env : e if startswith(e.name, "OTEL_EXPORTER_OTLP_METRICS")]) == 0
    error_message = "The deployed metric environment must follow the actual production profile, including rollback."
  }
  assert {
    condition = var.otel_metrics.enabled ? (
      one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL"]).value == "http/protobuf" &&
      one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"]).value == "cumulative"
    ) : true
    error_message = "Production metrics require cumulative HTTP/protobuf streams."
  }
  assert {
    condition = var.otel_metrics.enabled ? (
      length(google_secret_manager_secret_iam_member.@IAM@) == 1 &&
      google_secret_manager_secret_iam_member.@IAM@[0].secret_id == var.otel_metrics.headers_secret &&
      google_secret_manager_secret_iam_member.@IAM@[0].role == "roles/secretmanager.secretAccessor"
    ) : length(google_secret_manager_secret_iam_member.@IAM@) == 0
    error_message = "Only the enabled production header-secret reference may receive an IAM grant."
  }
  assert {
    condition = (
      one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_ENDPOINT"]).value == "https://traces.test/otlp" &&
      one([for e in @CONTAINER@.env : e if e.name == "OTEL_EXPORTER_OTLP_HEADERS"]).value_source[0].secret_key_ref[0].secret == "OTEL_EXPORTER_OTLP_HEADERS"
    )
    error_message = "Production metric routing must preserve the generic trace endpoint and credential."
  }
}
