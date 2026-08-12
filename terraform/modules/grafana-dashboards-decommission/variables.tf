# Only the provider inputs are needed here. The dashboard-shaping variables
# (datasource UIDs, folder title) belong to the real module and would be dead
# weight in a shim whose whole job is to forget resources.

variable "grafana_url" {
  description = "Grafana Cloud instance URL"
  type        = string
}

variable "grafana_auth" {
  description = "Grafana service account token"
  type        = string
  sensitive   = true
}
