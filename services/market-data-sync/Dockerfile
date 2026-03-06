# syntax=docker/dockerfile:1
FROM scratch AS stealth
# Build stage
FROM golang:1.26.0-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

# Copy parent module (contains pkg/otel) and market-data-sync module
COPY go.mod go.sum ./
COPY market-data-sync/go.mod market-data-sync/go.sum ./market-data-sync/

# Create a Go workspace to wire both modules together
RUN go work init . ./market-data-sync

# Download dependencies for both modules (with private module auth if available)
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
    cd market-data-sync && GOPRIVATE=github.com/skunkworq/* GONOSUMCHECK=github.com/skunkworq/* go mod download && \
    rm -f ~/.gitconfig

# Copy shared package source
COPY pkg/ pkg/

# Copy market-data-sync source
COPY market-data-sync/ market-data-sync/

# Build the application from the workspace
RUN cd market-data-sync && CGO_ENABLED=0 GOOS=linux go build -o /app/market-data-sync .

# Final stage
FROM alpine:3.19
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/market-data-sync .

# Default to API server mode (can override with -cli flag for CLI mode)
ENV PORT=8080
EXPOSE 8080

CMD ["./market-data-sync"]
