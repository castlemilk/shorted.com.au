variable "grafana_url" {
  description = "Grafana Cloud instance URL"
  type        = string
}

variable "grafana_auth" {
  description = "Grafana service account token"
  type        = string
  sensitive   = true
}

variable "prometheus_datasource_uid" {
  description = "UID of the Prometheus datasource in Grafana"
  type        = string
  default     = "grafanacloud-prom"
}

variable "tempo_datasource_uid" {
  description = "UID of the Tempo datasource in Grafana"
  type        = string
  default     = "grafanacloud-traces"
}

variable "folder_title" {
  description = "Grafana folder name for dashboards"
  type        = string
  default     = "Shorted"
}
