# syntax=docker/dockerfile:1
FROM scratch AS stealth
# Build stage
FROM golang:1.26.0-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git

# Set working directory
WORKDIR /app

# Copy go mod files (from services directory context)
COPY go.mod go.sum ./

# Download dependencies (with private module auth if available)
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

# Copy all source code
COPY . ./

# Restore go.mod with replace directive if using local stealth source
RUN [ -f /tmp/go.mod.stealth ] && cp /tmp/go.mod.stealth go.mod || true

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o shorts-service ./shorts/cmd/server

# Runtime stage
FROM alpine:3.19

# Install ca-certificates and Python for Yahoo Finance fetching
RUN apk --no-cache add ca-certificates python3 py3-pip

# Install yfinance for key metrics sync
RUN pip3 install --no-cache-dir yfinance --break-system-packages

WORKDIR /root/

# Copy the binary from builder
COPY --from=builder /app/shorts-service .

# Copy Python scripts for key metrics sync
COPY shorts/scripts/fetch_key_metrics.py /app/scripts/fetch_key_metrics.py

# Expose port
EXPOSE 9091

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:9091/health || exit 1

# Run the binary
CMD ["./shorts-service"]