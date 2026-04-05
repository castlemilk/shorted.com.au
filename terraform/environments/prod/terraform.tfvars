# Cloudflare credentials (same account as flaggr)
cloudflare_email          = "Ben.ebsworth@gmail.com"
cloudflare_zone_id        = "41b338d2d75853d7bedb9a93f1e824f1" # shorted.com.au zone
# cloudflare_api_token      = Set via TF_VAR_cloudflare_api_token in CI
# cloudflare_global_api_key = Set via TF_VAR_cloudflare_global_api_key in CI
# grafana_auth             = Set via TF_VAR_grafana_auth in CI
# cache_purge_secret       = Set via TF_VAR_cache_purge_secret in CI

# Weekly report generator image (pinned to monthly-fix with REPORT_TYPE support)
weekly_report_generator_image = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/weekly-report-generator:monthly-fix"
