# syntax=docker/dockerfile:1
FROM golang:1.26.0 AS builder

WORKDIR /app
COPY go.mod go.sum ./

# Remove local replace directive — Docker fetches stealth from module proxy
RUN sed -i '/replace github.com\/skunkworq\/stealth/d' go.mod

# Download dependencies (with private module auth if available)
RUN --mount=type=secret,id=github_token \
    if [ -f /run/secrets/github_token ]; then \
      git config --global url."https://x-access-token:$(cat /run/secrets/github_token)@github.com/skunkworq/".insteadOf "https://github.com/skunkworq/"; \
    fi && \
    GOPRIVATE=github.com/skunkworq/* GONOSUMCHECK=github.com/skunkworq/* go mod download && \
    rm -f ~/.gitconfig
COPY . .
RUN sed -i '/replace github.com\/skunkworq\/stealth/d' go.mod
RUN CGO_ENABLED=0 GOOS=linux go build -o /news-aggregator ./news-aggregator/

FROM gcr.io/distroless/static-debian12

COPY --from=builder /news-aggregator /news-aggregator
ENTRYPOINT ["/news-aggregator"]
