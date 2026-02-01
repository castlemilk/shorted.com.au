FROM golang:1.24.3 as build
WORKDIR /helloworld
# Copy dependencies list
COPY go.mod go.sum ./
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