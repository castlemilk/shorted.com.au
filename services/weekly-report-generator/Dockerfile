# syntax=docker/dockerfile:1
FROM golang:1.26.0-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY go.mod go.sum ./

# Download dependencies (with private module auth if available)
RUN --mount=type=secret,id=github_token \
    if [ -f /run/secrets/github_token ]; then \
      git config --global url."https://x-access-token:$(cat /run/secrets/github_token)@github.com/skunkworq/".insteadOf "https://github.com/skunkworq/"; \
    fi && \
    GOPRIVATE=github.com/skunkworq/* GONOSUMCHECK=github.com/skunkworq/* go mod download && \
    rm -f ~/.gitconfig

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o weekly-report-generator ./weekly-report-generator

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /app/weekly-report-generator /weekly-report-generator

CMD ["/weekly-report-generator"]
