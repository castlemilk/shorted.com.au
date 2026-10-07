# syntax=docker/dockerfile:1.7
#
# ONE Go build for every Go image in the deploy.
#
# Every Go service used to carry its own three-stage Dockerfile with the same
# builder, so a deploy compiled the shared `services` module eight times (plus
# twice more through ko) on one runner — over an hour of serialized builds in
# which any single stalled slot blocked the release (2026-10-07). Here the
# `builder` stage compiles every binary once and each image is a thin final
# stage selected with `--target` (see /docker-bake.hcl, which emits the same
# image names Terraform and the VKE chart already use).
#
# Build context: `services`. Targets (one per image):
#   shorted-jobs, shorted-jobs-browser, shorts, chat-service,
#   house-price-collector, enrichment-processor, asx-discovery,
#   market-data-sync, market-data, weekly-report-generator
#
# Private module: github.com/skunkworq/stealth. CI passes a GitHub token as the
# `github_token` secret; a laptop can instead pass a local checkout as the
# `stealth` build context (`--set '*.contexts.stealth=../stealth'`).

FROM scratch AS stealth

FROM --platform=$BUILDPLATFORM golang:1.26.0 AS builder
ARG TARGETOS TARGETARCH
ENV GOTOOLCHAIN=auto GOWORK=off GOPRIVATE=github.com/skunkworq/* GONOSUMCHECK=github.com/skunkworq/*
WORKDIR /app

# Module files first so the download layer caches across source changes.
COPY go.mod go.sum ./
COPY jobs/go.mod jobs/go.sum ./jobs/
COPY asx-discovery/go.mod asx-discovery/go.sum ./asx-discovery/
COPY market-data-sync/go.mod market-data-sync/go.sum ./market-data-sync/

RUN --mount=type=cache,id=shorted-gomod,target=/go/pkg/mod \
    --mount=type=secret,id=github_token \
    --mount=type=bind,from=stealth,target=/stealth-src \
    if [ -f /run/secrets/github_token ]; then \
      git config --global url."https://x-access-token:$(cat /run/secrets/github_token)@github.com/skunkworq/".insteadOf "https://github.com/skunkworq/"; \
    elif [ -f /stealth-src/go.mod ]; then \
      cp -r /stealth-src /stealth && \
      go mod edit -replace github.com/skunkworq/stealth=/stealth && \
      go mod edit -replace github.com/skunkworq/stealth=/stealth ./jobs/go.mod && \
      cp go.mod /tmp/go.mod.stealth && \
      cp jobs/go.mod /tmp/jobs.go.mod.stealth; \
    fi && \
    go mod download && \
    (cd jobs && go mod download) && \
    (cd asx-discovery && go mod download) && \
    (cd market-data-sync && go mod download) && \
    rm -f ~/.gitconfig

COPY . .
RUN [ -f /tmp/go.mod.stealth ] && cp /tmp/go.mod.stealth go.mod || true
RUN [ -f /tmp/jobs.go.mod.stealth ] && cp /tmp/jobs.go.mod.stealth jobs/go.mod || true

# One compile. Root-module binaries share one build cache pass; `jobs` is its
# own module; asx-discovery and market-data-sync build in a two-module
# workspace with the root (they import ./pkg), exactly as their old Dockerfiles
# did — one workspace at a time so neither sees the other's dependency set.
RUN --mount=type=cache,id=shorted-gomod,target=/go/pkg/mod \
    --mount=type=cache,id=shorted-gobuild,target=/root/.cache/go-build \
    set -eu; \
    export CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH}; \
    mkdir -p /out; \
    go build -o /out/shorts-service ./shorts/cmd/server; \
    go build -o /out/chat-service ./chat-service; \
    go build -o /out/enrichment-processor ./enrichment-processor; \
    go build -o /out/house-price-collector ./house-price-collector; \
    go build -o /out/market-data ./market-data; \
    go build -o /out/weekly-report-generator ./weekly-report-generator; \
    (cd jobs && go build -o /out/shorted ./cmd/shorted); \
    GOWORK=/app/go.work go work init . ./asx-discovery; \
    (cd asx-discovery && GOWORK=/app/go.work go build -o /out/asx-discovery .); \
    rm -f go.work go.work.sum; \
    GOWORK=/app/go.work go work init . ./market-data-sync; \
    (cd market-data-sync && GOWORK=/app/go.work go build -o /out/market-data-sync .); \
    rm -f go.work go.work.sum

# ---------------------------------------------------------------------------
# Shared runtime layers for the two Playwright images. Built once, reused by
# both targets; they do not depend on the Go sources so they cache for months.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS playwright-base
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
RUN mkdir -p /tmp/asx-downloads /root/.cache/ms-playwright-go && \
    chmod 777 /tmp/asx-downloads && \
    chmod 777 /root/.cache/ms-playwright-go
ENV DOWNLOAD_DIR=/tmp/asx-downloads

# ---------------------------------------------------------------------------
# Image targets. Names match the Artifact Registry repositories.
# ---------------------------------------------------------------------------

# shorted-jobs — the jobs monolith (`shorted <job>`), Cloud Run Jobs + VKE.
FROM gcr.io/distroless/static-debian12 AS shorted-jobs
COPY --from=builder /out/shorted /shorted
ENTRYPOINT ["/shorted"]

# shorted-jobs-browser — the same binary with Chromium for the browser jobs.
FROM playwright-base AS shorted-jobs-browser
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx --yes playwright@1.61.1 install chromium \
    && { PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx --yes playwright@1.61.1 install-deps chromium || true; } \
    && rm -rf /root/.npm /root/.cache
COPY --from=builder /out/shorted /shorted
ENTRYPOINT ["/shorted"]

# shorts — the API (Connect-RPC + MCP), with the yfinance key-metrics helper.
FROM alpine:3.19 AS shorts
RUN apk --no-cache add ca-certificates python3 py3-pip
RUN pip3 install --no-cache-dir yfinance --break-system-packages
WORKDIR /root/
COPY --from=builder /out/shorts-service .
COPY shorts/scripts/fetch_key_metrics.py /app/scripts/fetch_key_metrics.py
EXPOSE 9091
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:9091/health || exit 1
CMD ["./shorts-service"]

# chat-service — Gemini chat backend.
FROM gcr.io/distroless/static-debian12:nonroot AS chat-service
COPY --from=builder /out/chat-service /chat-service
EXPOSE 8080
ENTRYPOINT ["/chat-service"]

# house-price-collector — official housing ingest.
FROM gcr.io/distroless/static-debian12 AS house-price-collector
COPY --from=builder /out/house-price-collector /house-price-collector
ENTRYPOINT ["/house-price-collector"]

# market-data / weekly-report-generator — previously built by ko. Same shape
# as ko's output: a static nonroot base and the binary under /ko-app.
FROM gcr.io/distroless/static-debian12:nonroot AS market-data
COPY --from=builder /out/market-data /ko-app/market-data
ENTRYPOINT ["/ko-app/market-data"]

FROM gcr.io/distroless/static-debian12:nonroot AS weekly-report-generator
COPY --from=builder /out/weekly-report-generator /ko-app/weekly-report-generator
ENTRYPOINT ["/ko-app/weekly-report-generator"]

# market-data-sync — legacy price sweep service (superseded by `shorted sync`).
FROM alpine:3.19 AS market-data-sync
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /out/market-data-sync .
ENV PORT=8080
EXPOSE 8080
CMD ["./market-data-sync"]

# asx-discovery — legacy ASX discovery crawler (superseded by `shorted discovery`).
FROM playwright-base AS asx-discovery
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx --yes playwright@1.57.0 install chromium \
    && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx --yes playwright@1.57.0 install-deps chromium || true \
    && rm -rf /root/.npm /root/.cache
COPY --from=builder /out/asx-discovery .
CMD ["./asx-discovery"]

# enrichment-processor — Go binary over a Python/ML runtime (rembg, easyocr).
FROM python:3.11-slim-bookworm AS enrichment-processor
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libpng-dev \
    libjpeg-dev \
    libfreetype6-dev \
    libcairo2 \
    libpangocairo-1.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    g++ \
    git \
    wget \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    && pip install --upgrade pip setuptools wheel \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /tmp/* \
    && rm -rf /var/tmp/*
WORKDIR /app
COPY enrichment-processor/requirements.txt ./
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
    torch>=2.0.0 torchvision>=0.15.0 \
    && pip cache purge
RUN pip install --no-cache-dir -r requirements.txt \
    && pip cache purge \
    && rm -rf /root/.cache/pip \
    && rm -rf /tmp/* \
    && rm -rf /var/tmp/*
RUN wget --tries=5 --waitretry=10 --timeout=60 --retry-connrefused \
    https://raw.githubusercontent.com/ChaoningZhang/MobileSAM/master/weights/mobile_sam.pt -O mobile_sam.pt \
    && rm -rf /tmp/* /var/tmp/*
RUN python -c "from rembg import remove; import numpy as np; from PIL import Image; remove(np.zeros((10,10,3), dtype=np.uint8))" \
    && rm -rf /tmp/* /var/tmp/* /root/.cache/*
RUN python -c "import easyocr; reader = easyocr.Reader(['en'])" \
    && rm -rf /tmp/* /var/tmp/* /root/.cache/*
COPY --from=builder /out/enrichment-processor ./enrichment-processor
COPY enrichment-processor/logo_processor.py .
ENV PYTHONUNBUFFERED=1
ENV MOBILE_SAM_CHECKPOINT=/app/mobile_sam.pt
ENV CHROME_PATH=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium
CMD ["./enrichment-processor"]
