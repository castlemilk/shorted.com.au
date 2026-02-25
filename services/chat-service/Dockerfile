FROM golang:1.24 AS builder

WORKDIR /app

# Copy go.mod and go.sum for dependency caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Build the chat service
RUN CGO_ENABLED=0 GOOS=linux go build -o /chat-service ./chat-service/

# Final image
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /chat-service /chat-service

EXPOSE 8080

ENTRYPOINT ["/chat-service"]
