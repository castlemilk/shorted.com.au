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

analysis.postgres.start:
	docker-compose -f analysis/sql/docker-compose.yaml up -d

.PHONY: dev build test test.e2e test.smoke test.smoke.preview test.smoke.production test.smoke.ui test.setup analysis.postgres.start