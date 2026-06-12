/**
 * Cloudflare Edge Module — Outputs
 */

output "worker_name" {
  description = "Name of the deployed Cloudflare Worker"
  value       = cloudflare_workers_script.edge_cache.script_name
}

output "dns_record_hostname" {
  description = "The API hostname pointing to Cloudflare proxy"
  value       = var.create_api_record ? cloudflare_dns_record.api[0].name : var.domain
}

output "frontend_dns_hostname" {
  description = "The frontend hostname pointing to Cloudflare proxy"
  value       = var.create_frontend_records ? cloudflare_dns_record.frontend[0].name : "shorted.com.au"
}

output "edge_cache_enabled" {
  description = "Whether edge caching is active"
  value       = true
}

output "waf_enabled" {
  description = "Whether WAF managed rules are enabled"
  value       = var.waf_enabled
}

output "frontend_hostname" {
  description = "The frontend hostname (shorted.com.au)"
  value       = "shorted.com.au"
}

output "api_hostname" {
  description = "The API hostname (api.shorted.com.au)"
  value       = var.domain
}

output "kv_namespace_id" {
  description = "Cloudflare Workers KV namespace ID for edge cache"
  value       = cloudflare_workers_kv_namespace.edge_cache.id
}

output "kv_namespace_title" {
  description = "Title of the KV namespace"
  value       = cloudflare_workers_kv_namespace.edge_cache.title
}

output "prewarm_enabled" {
  description = "Whether KV pre-warming is enabled"
  value       = var.prewarm_enabled
}

output "prewarm_worker_name" {
  description = "Name of the pre-warm Cloudflare Worker"
  value       = var.prewarm_enabled ? cloudflare_workers_script.prewarm[0].script_name : null
}

output "prewarm_cron_schedule" {
  description = "Cron schedule for the pre-warm trigger"
  value       = var.prewarm_enabled ? tolist(cloudflare_workers_cron_trigger.prewarm[0].schedules)[0] : null
}
