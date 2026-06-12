# Real GCS backend (re-enabled June 2026). State previously went to a local
# file, so every CI plan started from scratch and showed create-everything
# instead of real diffs.
terraform {
  backend "gcs" {
    bucket = "shorted-dev-aba5688f-terraform-state"
    prefix = "env/dev"
  }
}
