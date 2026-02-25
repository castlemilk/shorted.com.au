# Build stage
FROM golang:1.24.3-alpine AS builder

WORKDIR /app

# Copy parent module (contains pkg/otel) and market-data-sync module
COPY go.mod go.sum ./
COPY market-data-sync/go.mod market-data-sync/go.sum ./market-data-sync/

# Create a Go workspace to wire both modules together
RUN go work init . ./market-data-sync

# Download dependencies for both modules
RUN go mod download
RUN cd market-data-sync && go mod download

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
