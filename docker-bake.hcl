# Every image the deploy publishes, in one `docker buildx bake`.
#
# The ten Go images come from ONE Dockerfile (services/images.Dockerfile) whose
# builder stage compiles the shared module once; each target is a thin final
# stage. The Python and Node images keep their own Dockerfiles. Image names and
# tags are exactly what .github/workflows/terraform-deploy.yml used to emit
# from its two matrix jobs, so Terraform and the VKE chart are untouched.
#
#   REGISTRY=<artifact-registry>/<project>/shorted IMAGE_TAG=main-<sha> \
#     docker buildx bake --push
#
# Laptop (no GitHub token): build one target for the native platform and hand
# the private module in as a build context:
#
#   docker buildx bake shorted-jobs --set '*.platform=linux/arm64' \
#     --set '*.contexts.stealth=../stealth' --load

variable "REGISTRY" {
  default = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted"
}

variable "IMAGE_TAG" {
  default = "dev"
}

variable "PLATFORM" {
  default = "linux/amd64"
}

function "tags" {
  params = [name]
  result = ["${REGISTRY}/${name}:${IMAGE_TAG}", "${REGISTRY}/${name}:latest"]
}

group "default" {
  targets = ["go", "python", "node"]
}

group "go" {
  targets = [
    "shorted-jobs",
    "shorted-jobs-browser",
    "shorts",
    "chat-service",
    "house-price-collector",
    "enrichment-processor",
    "asx-discovery",
    "market-data-sync",
    "market-data",
    "weekly-report-generator",
  ]
}

group "python" {
  targets = ["stock-price-ingestion", "signals-collector", "report-extractor"]
}

group "node" {
  targets = ["take-writer"]
}

# Shared settings for every Go target. `github_token` is read from the
# STEALTH_PAT environment variable when set (CI); absent, the Dockerfile falls
# back to the `stealth` build context, and absent that, the public proxy.
target "_go" {
  context    = "services"
  dockerfile = "images.Dockerfile"
  platforms  = [PLATFORM]
  secret     = ["id=github_token,env=STEALTH_PAT"]
}

target "shorted-jobs" {
  inherits = ["_go"]
  target   = "shorted-jobs"
  tags     = tags("shorted-jobs")
}

target "shorted-jobs-browser" {
  inherits = ["_go"]
  target   = "shorted-jobs-browser"
  tags     = tags("shorted-jobs-browser")
}

target "shorts" {
  inherits = ["_go"]
  target   = "shorts"
  tags     = tags("shorts")
}

target "chat-service" {
  inherits = ["_go"]
  target   = "chat-service"
  tags     = tags("chat-service")
}

target "house-price-collector" {
  inherits = ["_go"]
  target   = "house-price-collector"
  tags     = tags("house-price-collector")
}

target "enrichment-processor" {
  inherits = ["_go"]
  target   = "enrichment-processor"
  tags     = tags("enrichment-processor")
}

target "asx-discovery" {
  inherits = ["_go"]
  target   = "asx-discovery"
  tags     = tags("asx-discovery")
}

target "market-data-sync" {
  inherits = ["_go"]
  target   = "market-data-sync"
  tags     = tags("market-data-sync")
}

target "market-data" {
  inherits = ["_go"]
  target   = "market-data"
  tags     = tags("market-data")
}

target "weekly-report-generator" {
  inherits = ["_go"]
  target   = "weekly-report-generator"
  tags     = tags("weekly-report-generator")
}

target "stock-price-ingestion" {
  context   = "services/stock-price-ingestion"
  platforms = [PLATFORM]
  tags      = tags("stock-price-ingestion")
}

target "signals-collector" {
  context   = "services/signals-collector"
  platforms = [PLATFORM]
  tags      = tags("signals-collector")
}

target "report-extractor" {
  context   = "services/report-extractor"
  platforms = [PLATFORM]
  tags      = tags("report-extractor")
}

# take-writer bakes content/news into the image through a named context so a
# merged article is published from the exact tag that was built.
target "take-writer" {
  context   = "scripts/take-writer"
  platforms = [PLATFORM]
  contexts = {
    content = "content/news"
  }
  tags = tags("take-writer")
}
