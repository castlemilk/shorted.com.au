# syntax=docker/dockerfile:1
FROM scratch AS stealth
FROM golang:1.26.0 AS builder

WORKDIR /app

COPY go.mod go.sum ./

# Download dependencies (with private module auth if available). influence-collector
# imports NO stealth code — it is pgx + goquery + excelize + GCS only — but a bare
# `go mod download` resolves EVERY module services/go.mod requires, including the
# private github.com/skunkworq/stealth that services/pkg/stealthhttp depends on.
# So it needs the same bind-mount/PAT pattern as its siblings. Do not "optimise"
# this block away on the grounds that this collector doesn't use stealth.
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

RUN CGO_ENABLED=0 GOOS=linux go build -o /influence-collector ./influence-collector/

FROM gcr.io/distroless/static-debian12

COPY --from=builder /influence-collector /influence-collector

# CMD is LOAD-BEARING here, unlike the sibling collectors.
#
# This binary's flag default is `-mode tax` (main.go), NOT `all` — economy-collector
# and house-price-collector both default to `all`, so they need no CMD. An argless
# run of this image would silently ingest ATO corporate tax ONLY and skip
# emissions / austender / aec / lobbyists / trade, reporting success. Terraform
# also sets `args`, which overrides this; the CMD is the safety net for a manual
# `docker run` or a job created without args.
#
# The register-* modes are deliberately absent: they are excluded from `-mode all`
# so that a 804-document crawl of aph.gov.au can never fire from a deploy step,
# and they must stay off the default path.
ENTRYPOINT ["/influence-collector"]
CMD ["-mode", "all"]
