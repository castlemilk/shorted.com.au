FROM golang:1.24.3-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o weekly-report-generator ./weekly-report-generator

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /app/weekly-report-generator /weekly-report-generator

CMD ["/weekly-report-generator"]
