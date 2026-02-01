# TODO: Shorted.com.au Stability & Reliability Roadmap

**Generated:** 2026-02-01
**Purpose:** Prioritized action items to achieve a highly stable, secure, and maintainable codebase.

---

## Priority Legend

- **P0 (Critical)**: Security vulnerabilities or data integrity issues - Fix immediately
- **P1 (High)**: Significant architectural problems affecting reliability - Fix within 1 week
- **P2 (Medium)**: Code quality issues that should be addressed - Fix within 1 month
- **P3 (Low)**: Nice-to-have improvements - Backlog

---

## P0: Critical Security Issues

### Backend Security

- [ ] **Migrate JWT library** - `services/shorts/internal/services/shorts/tokens.go:7`
  - Replace `github.com/dgrijalva/jwt-go` with `github.com/golang-jwt/jwt/v5`
  - The old library has critical vulnerabilities (CVE-2020-26160) and is abandoned

- [ ] **Remove hardcoded secrets** - `services/shorts/internal/services/shorts/server.go:42`
  - Remove `tokenSecret := "dev-secret"` hardcoded value
  - Fail fast if `TOKEN_SECRET` env var is not set in production
  - Also fix in `middleware_connect.go:95-97` (dev-internal-secret)

- [ ] **Fix Terraform state storage** - `terraform/environments/dev/backend.tf`
  - Move state from local storage to GCS with encryption
  - Local state contains sensitive data and isn't team-accessible

- [ ] **Remove database credentials from Terraform** - `terraform/environments/dev/variables.tf:46`
  - Postgres username hardcoded in Git
  - Move to Secret Manager or environment variables

### Frontend Security

- [ ] **Audit dangerouslySetInnerHTML usage** - 10 files
  - Review all uses in SEO components for XSS risks
  - Ensure structured data uses safe JSON stringification
  - `web/src/app/layout.tsx`, `web/src/@/components/seo/enhanced-structured-data.tsx`

---

## P1: High Priority Reliability Issues

### Backend Reliability

- [ ] **Fix panic() in database initialization** - `services/shorts/internal/store/shorts/postgres.go:70-96`
  - Replace panic() with proper error returns
  - Add retry logic with exponential backoff
  - Allow graceful degradation instead of crashing

- [ ] **Replace MD5 with SHA-256 for cache keys** - `services/shorts/internal/services/shorts/cache.go:43-46`
  - MD5 has collision risks
  - Also handle JSON marshaling errors (currently silently ignored)

- [ ] **Add consistent query timeouts** - Throughout `services/shorts/internal/store/shorts/`
  - Many queries use `context.Background()` without timeout
  - Standardize on 10-second default timeout
  - Accept context from callers when available

- [ ] **Validate connection pool limits** - `services/shorts/internal/store/shorts/postgres.go:80-84`
  - Supabase has max 60 connections
  - Multiple services with 25 MaxConns each could exhaust pool
  - Document expected replicas and validate: `maxConns * replicas < 60`

- [ ] **Centralize admin email configuration** - `services/shorts/internal/services/shorts/middleware_connect.go:125-139`
  - Hardcoded admin emails in two places
  - Move to environment variable or database
  - Remove e2e-test account from production code

### Frontend Reliability

- [ ] **Fix infinite re-render in dashboard auto-save** - `web/src/app/dashboards/page.tsx:158-180`
  - `markPending` callback recreated every render
  - Use ref pattern to stabilize callback reference
  - JSON.stringify on every render is expensive

- [ ] **Fix useState misuse in widget loader** - `web/src/@/components/dashboard/dashboard-grid.tsx:492-503`
  - Using useState initializer for side effects (should be useEffect)
  - Causes component to load multiple times
  - Memory leaks from unresolved promises

- [ ] **Add cleanup to debounced functions** - `web/src/@/components/dashboard/widget-config-form.tsx:88-94`
  - Debounced search not cleaned up on unmount
  - Can cause state updates on unmounted component

- [ ] **Fix Memory leak in MultiSeriesChart** - `web/src/@/components/ui/multi-series-chart.tsx:1238`
  - Tooltip uses `Math.random()` as key
  - Creates new DOM nodes on every render
  - Change to stable key like `"multi-series-tooltip"`

---

## P2: Medium Priority Architecture Issues

### Backend Architecture

- [ ] **Standardize error handling patterns** - Throughout services
  - Mix of raw errors, wrapped errors, and Connect errors
  - Create custom error types for domain-specific errors
  - Always wrap errors with context: `fmt.Errorf("operation failed: %w", err)`

- [ ] **Add request ID tracing** - `services/shorts/internal/services/shorts/`
  - No correlation IDs across request lifecycle
  - Add middleware to inject/propagate X-Request-ID
  - Include in all log statements

- [ ] **Implement graceful shutdown** - `services/market-data/main.go:692`
  - Currently uses `http.ListenAndServe` which blocks indefinitely
  - Add signal handling for SIGTERM/SIGINT
  - Drain in-flight requests before shutdown

- [ ] **Add cache cleanup cancellation** - `services/shorts/internal/services/shorts/cache.go:117-130`
  - Cleanup goroutine runs forever with no stop mechanism
  - Add context-based cancellation via Close() method

- [ ] **Migrate to Pub/Sub v2** - `services/enrichment-processor/main.go:19`
  - Currently suppressing linter warnings for deprecated v1
  - Follow Google's migration guide

### Frontend Architecture

- [ ] **Standardize data fetching patterns** - Throughout `web/src/`
  - Mix of: Server Actions, React Query, InstantSearch, direct fetches
  - Standardize: Server Components use Server Actions, Client Components use React Query
  - Remove direct API calls from components

- [ ] **Fix stale closure in processOfflineQueue** - `web/src/@/hooks/use-auto-save.ts:83-117`
  - Empty dependency array causes stale closures
  - Add `onSave, onSaveSuccess, onSaveError` to dependencies

- [ ] **Fix race condition in undo/redo** - `web/src/@/hooks/use-undo-redo.ts:111-116`
  - Debounced commit creates race with undo operations
  - Flush pending changes before undo/redo

- [ ] **Use string dates in DashboardConfig** - `web/src/@/types/dashboard.ts:152-160`
  - Date objects can't serialize to localStorage
  - Use ISO 8601 strings, convert on use

### Infrastructure

- [x] **Optimize CI for 3-5 minute runs** - `.github/workflows/ci-fast.yml` (NEW)
  - Split sequential test job into parallel jobs
  - Separate unit tests from integration tests (testcontainers)
  - Add lint + typecheck as fast-fail gates
  - Run integration tests only on main branch merge

- [ ] **Remove continue-on-error from tests** - `.github/workflows/ci.yml:525,536,699`
  - Failing tests don't block merges
  - Fix flaky tests instead of ignoring failures

- [ ] **Migrate to ci-fast.yml** - Deprecate old ci.yml
  - Old workflow has disabled jobs and is slow (~10-15 min)
  - New workflow targets 3-5 min with parallel execution
  - Keep terraform-deploy.yml for preview/production deploys

- [ ] **Fix Docker base image versions** - `services/shorts/Dockerfile:2`
  - `golang:1.24-alpine` doesn't exist (latest is 1.23)
  - Pin to specific version like `golang:1.23.5-alpine`

- [ ] **Pin Alpine version** - `services/shorts/Dockerfile:23`
  - `FROM alpine:latest` is non-reproducible
  - Use `alpine:3.19` or specific version

### Proto/API

- [ ] **Decide on DashboardService** - `proto/shortedapi/dashboard/v1/dashboard.proto`
  - Fully defined in protobuf but NOT implemented
  - Frontend uses localStorage instead
  - Either implement or remove proto

- [ ] **Fix TimeSeriesData field numbering** - `proto/shortedtypes/stocks/v1alpha1/stocks.proto`
  - Field number 2 is missing
  - Add `reserved 2;` if field was deleted

- [ ] **Standardize float vs double** - Throughout proto files
  - `Stock` uses `float`, `StockPrice` uses `double`
  - Financial data should use `double` for precision
  - This is a wire-compatible change

---

## P3: Low Priority Improvements

### Code Cleanup

- [ ] **Remove unused storage backends** - `services/shorts/internal/store/shorts/config.go:6-9`
  - FireStore, MemoryStorage, DynamoDB defined but never used
  - Only PostgresStore is implemented

- [ ] **Remove CMS directory** - `/cms/`
  - Last modified April 2024
  - Node modules from 10 months ago
  - Likely abandoned Strapi CMS

- [ ] **Clean up orphaned user.pb.go** - `services/gen/proto/go/user/v1/user.pb.go`
  - Generated code exists without corresponding proto
  - Either remove or restore the proto

- [ ] **Remove empty.proto** - `proto/empty/empty.proto`
  - Serves no purpose beyond satisfying buf
  - Verify build works without it, then remove

- [ ] **Convert TODOs to issues** - Throughout codebase
  - `server.go:42`: "TODO: get from config"
  - `main.go:62`: "TODO: do some work normally"
  - Create GitHub issues and link them

### Documentation

- [ ] **Complete .env.example files** - `web/.env.example`, `services/.env.example`
  - Only 3 variables documented, app uses 20+
  - Document ALL environment variables

- [ ] **Add inline comments for financial terms** - Proto files
  - EPS, P/E ratio, etc. unclear for non-finance developers
  - Add explanatory comments

### Testing

- [ ] **Add error path tests** - Throughout test files
  - Many tests focus on happy paths
  - Add tests for: database failures, timeouts, invalid JWT, malformed input

- [ ] **Increase unit test coverage** - Target 70%+
  - Currently at ~40% threshold
  - Focus on complex business logic

### Performance

- [ ] **Consider code-splitting widget definitions** - `web/src/@/lib/widget-registry.ts:22-59`
  - All widget metadata loaded upfront
  - Could lazy-load definitions on demand

---

## Observability (Missing - High Priority Backlog)

- [ ] **Add structured logging** - Replace `log.Printf` with zerolog/zap
- [ ] **Add distributed tracing** - OpenTelemetry + Cloud Trace
- [ ] **Add error tracking** - Sentry for frontend and backend
- [ ] **Add performance monitoring** - APM solution
- [ ] **Add uptime monitoring** - External health checks (Pingdom/UptimeRobot)
- [ ] **Create runbooks** - Incident response procedures
- [ ] **Add alerting** - PagerDuty/Opsgenie integration

---

## Simplification Opportunities

### High Impact

1. **Consolidate auth stack**: Firebase Auth → NextAuth.js → Custom JWT → PostgreSQL sessions only
2. **Merge sync services**: daily-sync (Python) + market-data-sync (Go) → single Go service
3. **Remove unused proto**: DashboardService proto exists but isn't implemented
4. **Flatten proto structure**: 5 modules → single shorted.proto

### Medium Impact

5. **Consolidate to PostgreSQL**: Remove Firestore dependency for user data
6. **Remove enrichment review workflow**: Direct apply with audit log instead
7. **Standardize service-to-service auth**: Single internal JWT approach

---

## Quick Wins (< 1 day each)

1. Replace `Math.random()` tooltip key with stable string
2. Add `reserved 2;` to TimeSeriesData proto
3. Pin Docker base image versions
4. Add debounce cleanup in widget-config-form
5. Remove disabled jobs from ci.yml
6. Fix typos in IndustryTreeMap proto comments

---

## Metrics for Success

- [ ] Zero P0 issues
- [ ] Zero P1 issues
- [ ] 70%+ test coverage
- [ ] < 5 second cold start for all services
- [ ] < 100ms p95 latency for common queries
- [ ] Zero security vulnerabilities in dependency scan
- [ ] All secrets in Secret Manager (not hardcoded)
- [ ] Observability stack operational (logs, traces, metrics)
