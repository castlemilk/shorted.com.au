# Non-secret production routing. Enable only after receiver and both Secret
# Manager + shorted-jobs-env credentials have been provisioned and verified.
# Terraform plan/apply in the normal deployment pipeline load this file.
otel_metrics = {
  enabled        = true
  endpoint       = "https://origin-vke.telesis.dev/v1/metrics"
  headers_secret = "TELESIS_OTLP_METRICS_HEADERS"
}
