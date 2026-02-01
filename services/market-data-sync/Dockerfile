# Build stage
FROM golang:1.24.3-alpine AS builder

WORKDIR /app
# Copy go mod files from market-data-sync subdirectory
COPY market-data-sync/go.mod market-data-sync/go.sum ./
RUN go mod download

# Copy all source code from market-data-sync subdirectory
COPY market-data-sync/ .

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -o market-data-sync .

# Final stage
FROM alpine:3.19
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/market-data-sync .

# Default to API server mode (can override with -cli flag for CLI mode)
ENV PORT=8080
EXPOSE 8080

CMD ["./market-data-sync"]
