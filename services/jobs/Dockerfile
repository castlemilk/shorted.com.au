# syntax=docker/dockerfile:1
#
# Standard image for the consolidated `shorted <job>` batch binary.
# Build CONTEXT is services/ (the jobs module has a replace on ../ for pkg/*),
# e.g. from the repo root:
#
#   docker build -f services/jobs/Dockerfile services
#   docker build -f services/jobs/Dockerfile --secret id=github_token,env=GH_TOKEN services
#
# Cloud Run Jobs then pass the subcommand as args, e.g. args = ["influence", "-mode", "all"].
#
# The `FROM scratch AS stealth` stage is the same private-module trick every
# other service Dockerfile uses: pkg/enrichment → pkg/stealthhttp →
# github.com/skunkworq/stealth (private). Builders that can't mount the stealth
# source pass a GitHub token secret instead. Both paths are optional-by-design;
# with neither, `go mod download` fails fast on the private module.
#
# NEITHER go.mod carries a checked-in stealth `replace` (the local workspace
# gets it from services/go.work) — a committed `replace … => ../../../stealth`
# would resolve to a non-existent /stealth inside the image and break the
# GitHub-token branch before the token was ever consulted. The bind-mount branch
# ADDS the replace here; the token branch needs none.
FROM scratch AS stealth
FROM golang:1.26.0 AS builder

WORKDIR /app

# Parent module manifests first (the jobs module replaces ../ ).
COPY go.mod go.sum ./
COPY jobs/go.mod jobs/go.sum ./jobs/

RUN --mount=type=secret,id=github_token \
    --mount=type=bind,from=stealth,target=/stealth-src \
    export GOTOOLCHAIN=auto && \
    if [ -f /run/secrets/github_token ]; then \
      git config --global url."https://x-access-token:$(cat /run/secrets/github_token)@github.com/skunkworq/".insteadOf "https://github.com/skunkworq/"; \
    elif [ -f /stealth-src/go.mod ]; then \
      cp -r /stealth-src /stealth && \
      go mod edit -replace github.com/skunkworq/stealth=/stealth && \
      go mod edit -replace github.com/skunkworq/stealth=/stealth ./jobs/go.mod && \
      cp go.mod /tmp/go.mod.stealth && \
      cp jobs/go.mod /tmp/jobs.go.mod.stealth; \
    fi && \
    cd jobs && \
    GOPRIVATE=github.com/skunkworq/* go mod download && \
    rm -f ~/.gitconfig

COPY . .

# Restore the go.mod files carrying the local-stealth replace (COPY . . above
# overwrote them with the checked-in versions).
RUN [ -f /tmp/go.mod.stealth ] && cp /tmp/go.mod.stealth go.mod || true
RUN [ -f /tmp/jobs.go.mod.stealth ] && cp /tmp/jobs.go.mod.stealth jobs/go.mod || true

# Build in module mode: the workspace file (go.work) is irrelevant here and
# GOWORK=off keeps the image build independent of sibling modules.
RUN cd jobs && GOTOOLCHAIN=auto GOWORK=off CGO_ENABLED=0 GOOS=linux go build -o /shorted ./cmd/shorted

FROM gcr.io/distroless/static-debian12

COPY --from=builder /shorted /shorted

ENTRYPOINT ["/shorted"]
