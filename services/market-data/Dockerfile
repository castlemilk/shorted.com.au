# syntax=docker/dockerfile:1
# Build stage
FROM golang:1.26.0-alpine AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache git

# Copy go mod files (build context is services/ directory)
COPY go.mod go.sum ./

# Download dependencies (with private module auth if available)
RUN --mount=type=secret,id=github_token \
    if [ -f /run/secrets/github_token ]; then \
      git config --global url."https://x-access-token:$(cat /run/secrets/github_token)@github.com/skunkworq/".insteadOf "https://github.com/skunkworq/"; \
    fi && \
    GOPRIVATE=github.com/skunkworq/* GONOSUMCHECK=github.com/skunkworq/* go mod download && \
    rm -f ~/.gitconfig

# Copy generated proto files
COPY gen/ ./gen/

# Copy shared packages
COPY pkg/ ./pkg/

# Copy market-data source code (only .go files, not Dockerfile.go)
COPY market-data/main.go market-data/validation.go ./

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o market-data-service .

# Runtime stage
FROM alpine:3.19

# Install ca-certificates and wget for HTTPS and health checks
RUN apk --no-cache add ca-certificates wget

WORKDIR /app

# Copy binary from builder
COPY --from=builder /build/market-data-service .

# Create non-root user
RUN adduser -D -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 8090

# Set environment
ENV PORT=8090

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8090/health || exit 1

# Run the service
CMD ["./market-data-service"]
