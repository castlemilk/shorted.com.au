BASE_URL := http://localhost:8080

run.shorts:
	go run shorts/cmd/server/main.go
build.shorts:
	docker buildx build --progress=plain --platform linux/amd64,darwin/arm64,linux/arm64/v8 -f shorts/cmd/server/Dockerfile -t shorts:latest .
	docker buildx build --load -f shorts/cmd/server/Dockerfile -t shorts:latest .
run.docker.shorts:
	docker run -e APP_STORE_POSTGRES_ADDRESS=postgres:5432 --link postgres --net sql_default -p 8080:8080 shorts:latest 
test.gettopshorts:
	curl \
    --header "Content-Type: application/json" \
	--data '{"period": "1y", "limit": 10}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetTopShorts -v