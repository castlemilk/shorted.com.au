FROM golang:1.26.0 AS builder

WORKDIR /app
COPY go.mod go.sum ./

# Remove local replace directive — Docker fetches stealth from module proxy
RUN sed -i '/replace github.com\/skunkworq\/stealth/d' go.mod

RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /news-aggregator ./news-aggregator/

FROM gcr.io/distroless/static-debian12

COPY --from=builder /news-aggregator /news-aggregator
ENTRYPOINT ["/news-aggregator"]
