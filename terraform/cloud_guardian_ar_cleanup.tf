# Cloud Guardian: Artifact Registry cleanup policy for cloud-run-source-deploy
# This adds a lifecycle policy to automatically delete old images.

resource "google_artifact_registry_repository_cleanup_policy" "cloud_guardian_cloud_run_source_deploy" {
  repository = "cloud-run-source-deploy"
  location   = ""
  project    = "shorted-dev-aba5688f"

  cleanup_policy {
    id     = "keep-latest-10"
    action = "KEEP"

    most_recent_versions {
      keep_count = 10
    }
  }
}
