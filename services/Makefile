BASE_URL := http://localhost:8080

run.shorts:
	go run shorts/cmd/server/main.go
build.shorts:
	docker buildx build --platform linux/amd64 -f shorts/cmd/server/Dockerfile -t shorts:latest .
test.gettopshorts:
	curl \
    --header "Content-Type: application/json" \
	--data '{"period": "1y", "limit": 10}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetTopShorts -v