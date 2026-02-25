FROM golang:1.24 AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /news-aggregator ./news-aggregator/

FROM gcr.io/distroless/static-debian12

COPY --from=builder /news-aggregator /news-aggregator
ENTRYPOINT ["/news-aggregator"]
