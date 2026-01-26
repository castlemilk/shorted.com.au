# Build stage
FROM golang:1.24-alpine AS builder

WORKDIR /app
# Copy go mod files from asx-discovery subdirectory
COPY asx-discovery/go.mod asx-discovery/go.sum ./
RUN go mod download

# Copy all source code from asx-discovery subdirectory
COPY asx-discovery/ .

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -o asx-discovery .

# Final stage - use a Debian-based image for Playwright browser support
FROM debian:bookworm-slim

# Install Node.js and npm for Playwright browser installation
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies for Playwright browsers
RUN apt-get update && apt-get install -y \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright browsers to a specific path
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx --yes playwright@latest install chromium \
    && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx --yes playwright@latest install-deps chromium || true \
    && rm -rf /root/.npm /root/.cache

WORKDIR /app
COPY --from=builder /app/asx-discovery .

# Ensure directories exist for Playwright driver and downloads
RUN mkdir -p /tmp/asx-downloads /root/.cache/ms-playwright-go && \
    chmod 777 /tmp/asx-downloads && \
    chmod 777 /root/.cache/ms-playwright-go

ENV DOWNLOAD_DIR=/tmp/asx-downloads

CMD ["./asx-discovery"]
