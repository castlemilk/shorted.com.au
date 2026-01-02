# Build stage
FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o market-data-sync main.go

# Final stage
FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/market-data-sync .

# Default to API server mode (can override with -cli flag for CLI mode)
ENV PORT=8080
EXPOSE 8080

CMD ["./market-data-sync"]
