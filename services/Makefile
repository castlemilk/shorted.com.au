BASE_URL := http://localhost:8080
SHORTS_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/shorts
SHORTS_VERSION := `git describe --tags --always --dirty`
SHORTS_SYNC_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/short-data-sync

gcloud.init:
	gcloud artifacts repositories create shorted \
    --repository-format=docker \
    --location="australia-southeast2" \
    --description="shorts service image" \
    --immutable-tags \
    --async

run.shorts:
	go run shorts/cmd/server/main.go
build.short-data-sync:
	cd short-data-sync; docker buildx build --push --progress=plain --platform linux/amd64,linux/arm64 -f Dockerfile -t ${SHORTS_SYNC_IMAGE}:latest -t ${SHORTS_SYNC_IMAGE}:${SHORTS_VERSION} .
build.shorts:
	docker buildx build --push --progress=plain --platform linux/amd64,darwin/arm64,linux/arm64/v8 -f shorts/cmd/server/Dockerfile -t ${SHORTS_IMAGE}:${SHORTS_VERSION} .
	# docker buildx build --load -f shorts/cmd/server/Dockerfile -t ${SHORTS_IMAGE}:${SHORTS_VERSION} .
gcr.init:
	gcloud auth configure-docker asia.gcr.io
gcr.push:
	docker push ${SHORTS_IMAGE}:${SHORTS_VERSION}

run.docker.shorts-data-sync.local.standalone:
	docker run \
		-e DATABASE_URL=postgresql://admin:password@postgres:5432/shorts \
		-e GOOGLE_APPLICATION_CREDENTIALS=/app/shorted-dev-aba5688f-06b39f2f41fc.json \
		-v $(PWD)/../analysis/data/shorts/:/app/data/shorts/ \
		-v $(PWD)/short-data-sync/shorted-dev-aba5688f-06b39f2f41fc.json:/app/shorted-dev-aba5688f-06b39f2f41fc.json \
	 --link postgres -it --net sql_default -p 8080:8080 --entrypoint "python" ${SHORTS_SYNC_IMAGE}:${SHORTS_VERSION} main.py

run.docker.shorts-data-sync.local:
	docker run \
		-e DATABASE_URL=postgresql://admin:password@postgres:5432/shorts \
		-e GOOGLE_APPLICATION_CREDENTIALS=/app/shorted-dev-aba5688f-06b39f2f41fc.json \
		-v $(PWD)/../analysis/data/shorts/:/app/data/shorts/ \
		-v $(PWD)/short-data-sync/shorted-dev-aba5688f-06b39f2f41fc.json:/app/shorted-dev-aba5688f-06b39f2f41fc.json \
	 --link postgres --net sql_default -p 8080:8080  ${SHORTS_SYNC_IMAGE}:${SHORTS_VERSION}

run.docker.shorts.local:
	docker run \
		-e APP_STORE_POSTGRES_ADDRESS=postgres:5432 \
	 --link postgres --net sql_default -p 8080:8080 --name sync-service shorts:latest 
run.docker.shorts.superbase:
	docker run \
		-e APP_STORE_POSTGRES_ADDRESS=aws-0-ap-southeast-2.pooler.supabase.com:6543 \
		-e APP_STORE_POSTGRES_DATABASE=postgres \
		-e APP_STORE_POSTGRES_USERNAME=postgres.xivfykscsdagwsreyqgf \
		-e APP_STORE_POSTGRES_PASSWORD=6tOCck692RrQJzXL \
	 --link postgres --net sql_default -p 8080:8080 --name shorts-service ${SHORTS_IMAGE}:${SHORTS_VERSION}
deploy.gcr.shorts:
	VERSION=${SHORTS_VERSION} IMAGE_NAME=${SHORTS_IMAGE} envsubst < shorts/cmd/server/service.template.yaml > shorts/cmd/server/service.yaml && \
	gcloud run services replace shorts/cmd/server/service.yaml --region australia-southeast2

deploy.job.shorts-data-sync:
	VERSION=${SHORTS_VERSION} IMAGE_NAME=${SHORTS_SYNC_IMAGE} envsubst < short-data-sync/job.template.yaml > short-data-sync/job.yaml && \
	gcloud run jobs replace --region australia-southeast2 short-data-sync/job.yaml

deploy.gcr.shorts-data-sync:
	VERSION=${SHORTS_VERSION} IMAGE_NAME=${SHORTS_SYNC_IMAGE} envsubst < short-data-sync/service.template.yaml > short-data-sync/service.yaml && \
	gcloud run services replace short-data-sync/service.yaml --region australia-southeast2
	
test.gettopshorts:
	curl \
    --header "Content-Type: application/json" \
	--data '{"period": "1m", "limit": 10}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetTopShorts -v | jq -r

test.getstock:
	curl \
    --header "Content-Type: application/json" \
	--data '{"productCode": "BBFD"}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetStock -v

test.getstockdetails:
	curl \
    --header "Content-Type: application/json" \
	--data '{"productCode": "PLS"}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetStockDetails -v


test.getstockdata:
	curl \
    --header "Content-Type: application/json" \
	--data '{"productCode": "PLS", "period": "1y"}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetStockData -v
	