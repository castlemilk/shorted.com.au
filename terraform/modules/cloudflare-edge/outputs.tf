/**
 * Cloudflare Edge Module — Outputs
 */

output "worker_name" {
  description = "Name of the deployed Cloudflare Worker"
  value       = cloudflare_workers_script.edge_cache.name
}

output "dns_record_hostname" {
  description = "The API hostname pointing to Cloudflare proxy"
  value       = var.create_api_record ? cloudflare_record.api[0].hostname : var.domain
}

output "frontend_dns_hostname" {
  description = "The frontend hostname pointing to Cloudflare proxy"
  value       = var.create_frontend_records ? cloudflare_record.frontend[0].hostname : "shorted.com.au"
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
