dev:
	npm run dev

build:
	npm run build

test:
	npm test

test.e2e:
	npm run test:e2e

# Run smoke tests against local server
test.smoke:
	BASE_URL=http://localhost:3020 npx playwright test e2e/smoke.spec.ts --project=chromium

# Run smoke tests against preview deployment
test.smoke.preview:
	BASE_URL=https://preview.shorted.com.au npx playwright test e2e/smoke.spec.ts --project=chromium

# Run smoke tests against production
test.smoke.production:
	BASE_URL=https://shorted.com.au npx playwright test e2e/smoke.spec.ts --project=chromium

# Run all smoke tests with UI
test.smoke.ui:
	BASE_URL=http://localhost:3020 npx playwright test e2e/smoke.spec.ts --ui

# Install Playwright browsers
test.setup:
	npx playwright install --with-deps

# Run Algolia search tests
test.search:
	BASE_URL=http://localhost:3020 npx playwright test e2e/algolia-search.spec.ts --project=chromium

# Run authenticated tests (requires setup project first)
test.auth:
	BASE_URL=http://localhost:3020 npx playwright test --project=setup --project=chromium-authenticated

# Run all Playwright tests with UI
test.ui:
	BASE_URL=http://localhost:3020 npx playwright test --ui

# Run tests against a preview deployment
test.preview:
	@if [ -z "$(BASE_URL)" ]; then echo "Usage: make test.preview BASE_URL=https://your-preview.vercel.app"; exit 1; fi
	npx playwright test e2e/smoke.spec.ts e2e/algolia-search.spec.ts --project=chromium

# Run tests against the PR preview (uses SHORTS_URL for backend)
test.pr:
	@if [ -z "$(PR)" ]; then echo "Usage: make test.pr PR=44"; exit 1; fi
	BASE_URL=https://shorted-com-au-git-feature-user-profil-c2412d-document-analyser.vercel.app \
	SHORTS_URL=https://shorts-service-pr-$(PR)-ak2zgjnhlq-km.a.run.app \
	npx playwright test e2e/smoke.spec.ts e2e/algolia-search.spec.ts --project=chromium

analysis.postgres.start:
	docker-compose -f analysis/sql/docker-compose.yaml up -d

.PHONY: dev build test test.e2e test.smoke test.smoke.preview test.smoke.production test.smoke.ui test.setup test.search test.auth test.ui test.preview test.pr analysis.postgres.start