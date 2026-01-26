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

# =========================================
# Algolia Index Management
# =========================================

# Sync Algolia index with local database
algolia.sync:
	@echo "🔄 Syncing Algolia index with local database..."
	DATABASE_URL=postgresql://admin:password@localhost:5438/shorts \
	ALGOLIA_APP_ID=$(ALGOLIA_APP_ID) \
	ALGOLIA_ADMIN_KEY=$(ALGOLIA_ADMIN_KEY) \
	ALGOLIA_INDEX=stocks \
	npx tsx scripts/sync-algolia.ts

# Sync Algolia index with production database
algolia.sync.prod:
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL required. Usage: make algolia.sync.prod DATABASE_URL=postgresql://..."; exit 1; fi
	@echo "🔄 Syncing Algolia index with production database..."
	DATABASE_URL=$(DATABASE_URL) \
	ALGOLIA_APP_ID=$(ALGOLIA_APP_ID) \
	ALGOLIA_ADMIN_KEY=$(ALGOLIA_ADMIN_KEY) \
	ALGOLIA_INDEX=stocks \
	npx tsx scripts/sync-algolia.ts

# View Algolia index stats
algolia.stats:
	@echo "📊 Fetching Algolia index stats..."
	@npx tsx -e " \
		const { algoliasearch } = require('algoliasearch'); \
		const client = algoliasearch('$(ALGOLIA_APP_ID)', '$(ALGOLIA_ADMIN_KEY)'); \
		client.getSettings({ indexName: 'stocks' }).then(s => { \
			console.log('Index: stocks'); \
			console.log('Searchable attributes:', s.searchableAttributes?.length || 0); \
			console.log('Facets:', s.attributesForFaceting?.length || 0); \
		}).catch(e => console.error('Error:', e.message)); \
	"

# Clear Algolia index (use with caution!)
algolia.clear:
	@echo "⚠️  WARNING: This will clear all records from the Algolia index!"
	@read -p "Are you sure? Type 'yes' to confirm: " confirm && [ "$$confirm" = "yes" ] || exit 1
	@echo "🗑️  Clearing Algolia index..."
	@npx tsx -e " \
		const { algoliasearch } = require('algoliasearch'); \
		const client = algoliasearch('$(ALGOLIA_APP_ID)', '$(ALGOLIA_ADMIN_KEY)'); \
		client.clearObjects({ indexName: 'stocks' }).then(() => console.log('✅ Index cleared')); \
	"

# Test Algolia search
algolia.search:
	@if [ -z "$(Q)" ]; then echo "Usage: make algolia.search Q=BHP"; exit 1; fi
	@echo "🔍 Searching Algolia for: $(Q)"
	@npx tsx -e " \
		const { algoliasearch } = require('algoliasearch'); \
		const client = algoliasearch('$(ALGOLIA_APP_ID)', process.env.ALGOLIA_SEARCH_KEY || '$(ALGOLIA_SEARCH_KEY)'); \
		client.search({ requests: [{ indexName: 'stocks', query: '$(Q)', hitsPerPage: 5 }] }).then(r => { \
			console.log('Found', r.results[0].nbHits, 'results:'); \
			r.results[0].hits.forEach(h => console.log(' -', h.stock_code, h.company_name)); \
		}).catch(e => console.error('Error:', e.message)); \
	"

.PHONY: dev build test test.e2e test.smoke test.smoke.preview test.smoke.production test.smoke.ui test.setup test.search test.auth test.ui test.preview test.pr analysis.postgres.start algolia.sync algolia.sync.prod algolia.stats algolia.clear algolia.search