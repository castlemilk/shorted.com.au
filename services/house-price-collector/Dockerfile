# syntax=docker/dockerfile:1
FROM scratch AS stealth
FROM golang:1.26.0 AS builder

WORKDIR /app

COPY go.mod go.sum ./

# Download dependencies (with private module auth if available). The collector
# imports services/pkg/stealthhttp for the crawl tier, which depends on the
# skunkworq/stealth private module — same bind-mount/PAT pattern as the other
# stealth-using services.
RUN --mount=type=secret,id=github_token \
    --mount=type=bind,from=stealth,target=/stealth-src \
    if [ -f /run/secrets/github_token ]; then \
      git config --global url."https://x-access-token:$(cat /run/secrets/github_token)@github.com/skunkworq/".insteadOf "https://github.com/skunkworq/"; \
    elif [ -f /stealth-src/go.mod ]; then \
      cp -r /stealth-src /stealth && \
      go mod edit -replace github.com/skunkworq/stealth=/stealth && \
      cp go.mod /tmp/go.mod.stealth; \
    fi && \
    GOPRIVATE=github.com/skunkworq/* GONOSUMCHECK=github.com/skunkworq/* go mod download && \
    rm -f ~/.gitconfig

COPY . .

# Restore go.mod with the replace directive if using local stealth source.
RUN [ -f /tmp/go.mod.stealth ] && cp /tmp/go.mod.stealth go.mod || true

RUN CGO_ENABLED=0 GOOS=linux go build -o /house-price-collector ./house-price-collector/

FROM gcr.io/distroless/static-debian12

COPY --from=builder /house-price-collector /house-price-collector

# Default mode is "all" = ABS/RBA official ingest + MV refresh. The supplementary
# crawl (-mode crawl) is opt-in and needs Chromium + residential egress — it is
# NOT run by the scheduled job.
ENTRYPOINT ["/house-price-collector"]
