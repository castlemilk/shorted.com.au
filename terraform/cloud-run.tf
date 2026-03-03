resource "google_cloud_run_v2_service" "default" {
  name     = "cms"
  location = "australia-southeast2"
  project  = var.project_id

  template {
    containers {
      image = "australia-southeast2-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker_repo.repository_id}/cms:latest"
      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }
    }
    timeout = "300s"

    scaling {
      min_instances = 0
      max_instances = 3
    }

    traffic {
      type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
      percent = 100
    }
  }

 autogenerate_revision_name = true

  ingress = "INGRESS_TRAFFIC_ALL"
}
