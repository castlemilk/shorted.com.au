# Step 1: Build the application in a full Go environment
FROM golang:1.20-alpine AS builder

# Install git.
# Git is required for fetching the dependencies.
RUN apk add --no-cache git

# Set the Current Working Directory inside the container
WORKDIR /app

# Copy go mod and sum files
COPY go.mod go.sum ./

# Download all dependencies. Dependencies will be cached if the go.mod and go.sum files are not changed
RUN go mod download

# Copy the source from the current directory to the Working Directory inside the container
COPY gen ./gen

COPY pkg ./pkg

COPY shorts ./shorts

# Build the Go app
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o shorts ./shorts/cmd/server/main.go

# Step 2: Use a minimal runtime environment
FROM scratch

# Copy the Pre-built binary file from the previous stage. 
COPY --from=builder /app/shorts .

# Command to run the executable
CMD ["./shorts"]
