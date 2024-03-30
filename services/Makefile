BASE_URL := http://localhost:8080
SHORTS_VERSION := `git describe --tags --always --dirty`

run.shorts:
	go run shorts/cmd/server/main.go
build.shorts:
	docker buildx build --push --progress=plain --platform linux/amd64,darwin/arm64,linux/arm64/v8 -f shorts/cmd/server/Dockerfile -t asia.gcr.io/shorted-dev-aba5688f/shorted/shorts:${SHORTS_VERSION} .
	# docker buildx build --load -f shorts/cmd/server/Dockerfile -t asia.gcr.io/shorted-dev-aba5688f/shorted/shorts:${SHORTS_VERSION} .
gcr.init:
	gcloud auth configure-docker asia.gcr.io
gcr.push:
	docker push asia.gcr.io/shorted-dev-aba5688f/shorted/shorts:${SHORTS_VERSION}
run.docker.shorts.local:
	docker run \
		-e APP_STORE_POSTGRES_ADDRESS=postgres:5432 \
	 --link postgres --net sql_default -p 8080:8080 shorts:latest 
run.docker.shorts.superbase:
	docker run \
		-e APP_STORE_POSTGRES_ADDRESS=aws-0-ap-southeast-2.pooler.supabase.com:6543 \
		-e APP_STORE_POSTGRES_DATABASE=postgres \
		-e APP_STORE_POSTGRES_USERNAME=postgres.xivfykscsdagwsreyqgf \
		-e APP_STORE_POSTGRES_PASSWORD=6tOCck692RrQJzXL \
	 --link postgres --net sql_default -p 8080:8080 asia.gcr.io/shorted-dev-aba5688f/shorted/shorts:${SHORTS_VERSION}
deploy.gcr.shorts:
	VERSION=${SHORTS_VERSION} envsubst < shorts/cmd/server/service.template.yaml > shorts/cmd/server/service.yaml && \
	gcloud run services replace shorts/cmd/server/service.yaml --region australia-southeast2

test.gettopshorts:
	curl \
    --header "Content-Type: application/json" \
	--data '{"period": "1y", "limit": 10}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetTopShorts -v