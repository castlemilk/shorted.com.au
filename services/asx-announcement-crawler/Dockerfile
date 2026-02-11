FROM golang:1.24 AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /asx-announcement-crawler ./asx-announcement-crawler/

FROM gcr.io/distroless/static-debian12

COPY --from=builder /asx-announcement-crawler /asx-announcement-crawler

ENTRYPOINT ["/asx-announcement-crawler"]
