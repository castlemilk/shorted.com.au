# syntax=docker/dockerfile:1
FROM scratch AS stealth
FROM golang:1.26.0 as build
WORKDIR /helloworld
# Copy dependencies list
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