# Build stage
FROM golang:1.24.3-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git

# Set working directory
WORKDIR /app

# Copy go mod files (from services directory context)
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy all source code
COPY . ./

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