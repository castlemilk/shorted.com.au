# syntax=docker/dockerfile:1
FROM scratch AS stealth
FROM golang:1.26.0 AS builder

WORKDIR /app

# Copy go.mod and go.sum for dependency caching
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

# Copy source
COPY . .

# Restore go.mod with replace directive if using local stealth source
RUN [ -f /tmp/go.mod.stealth ] && cp /tmp/go.mod.stealth go.mod || true

# Build the chat service
RUN CGO_ENABLED=0 GOOS=linux go build -o /chat-service ./chat-service/

# Final image
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /chat-service /chat-service

EXPOSE 8080

ENTRYPOINT ["/chat-service"]
