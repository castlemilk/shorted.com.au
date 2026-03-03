# syntax=docker/dockerfile:1
FROM golang:1.26.0 as build
WORKDIR /helloworld
# Copy dependencies list
COPY go.mod go.sum ./
# Remove local replace directive — Docker fetches stealth from module proxy
RUN sed -i '/replace github.com\/skunkworq\/stealth/d' go.mod
# Download dependencies (with private module auth if available)
RUN --mount=type=secret,id=github_token \
    if [ -f /run/secrets/github_token ]; then \
      git config --global url."https://x-access-token:$(cat /run/secrets/github_token)@github.com/skunkworq/".insteadOf "https://github.com/skunkworq/"; \
    fi && \
    GOPRIVATE=github.com/skunkworq/* GONOSUMCHECK=github.com/skunkworq/* go mod download && \
    rm -f ~/.gitconfig
# Build with optional lambda.norpc tag
COPY management ./management
COPY gen ./gen
COPY pkg ./pkg
RUN CGO_ENABLED=0 GOOS=linux go build -tags lambda.norpc -o main management/cmd/lambda/main.go

FROM public.ecr.aws/lambda/provided:al2
COPY --from=build /helloworld/main ./main

# Set execute permission
RUN chmod 755 ./main
ENTRYPOINT [ "./main" ]