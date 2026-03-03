FROM golang:1.26.0 AS builder

WORKDIR /app

# Copy go.mod and go.sum for dependency caching
COPY go.mod go.sum ./

# Remove local replace directive — Docker fetches stealth from module proxy
RUN sed -i '/replace github.com\/skunkworq\/stealth/d' go.mod

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
