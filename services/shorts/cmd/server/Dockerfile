# syntax=docker/dockerfile:1
# Step 1: Build the application in a full Go environment
FROM --platform=$BUILDPLATFORM golang:1.26.0-alpine AS builder

# Install git.
# Git is required for fetching the dependencies.
RUN apk add --no-cache git

# Set the Current Working Directory inside the container
WORKDIR /app

# Copy go mod and sum files
COPY go.mod go.sum ./

# Download dependencies (with private module auth if available)
RUN --mount=type=secret,id=github_token \
    if [ -f /run/secrets/github_token ]; then \
      git config --global url."https://x-access-token:$(cat /run/secrets/github_token)@github.com/skunkworq/".insteadOf "https://github.com/skunkworq/"; \
    fi && \
    GOPRIVATE=github.com/skunkworq/* GONOSUMCHECK=github.com/skunkworq/* go mod download && \
    rm -f ~/.gitconfig

# Copy the source from the current directory to the Working Directory inside the container
COPY gen ./gen

COPY pkg ./pkg

COPY shorts ./shorts
ARG TARGETOS TARGETARCH

# Build the Go app
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -o shorts-server ./shorts/cmd/server/main.go

# Step 2: Use a minimal runtime environment
FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Copy the Pre-built binary file from the previous stage. 
COPY --from=builder /app/shorts-server ./shorts-server
# Command to run the executable
CMD ["./shorts-server"]
