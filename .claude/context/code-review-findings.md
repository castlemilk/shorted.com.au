# Code Review Findings Summary

**Date:** 2026-02-01
**Reviewer:** Claude Code Deep Analysis

## Quick Reference for Future Sessions

### Critical Security Issues (Fix Immediately)

1. **JWT Library Vulnerability**
   - File: `services/shorts/internal/services/shorts/tokens.go:7`
   - Issue: Using abandoned `github.com/dgrijalva/jwt-go` with CVE-2020-26160
   - Fix: Migrate to `github.com/golang-jwt/jwt/v5`

2. **Hardcoded Secrets**
   - File: `services/shorts/internal/services/shorts/server.go:42`
   - Issue: `tokenSecret := "dev-secret"` in production code
   - Fix: Fail fast if `TOKEN_SECRET` env var missing

3. **Terraform State Exposure**
   - File: `terraform/environments/dev/backend.tf`
   - Issue: State stored locally (contains secrets)
   - Fix: Move to GCS backend with encryption

### High Priority Bugs

4. **Infinite Re-render Risk**
   - File: `web/src/app/dashboards/page.tsx:158-180`
   - Issue: `markPending` callback causes re-render loop
   - Fix: Use ref pattern to stabilize callback

5. **useState Misuse**
   - File: `web/src/@/components/dashboard/dashboard-grid.tsx:492-503`
   - Issue: Side effects in useState initializer
   - Fix: Move to useEffect with cleanup

6. **Memory Leak**
   - File: `web/src/@/components/ui/multi-series-chart.tsx:1238`
   - Issue: `Math.random()` as key creates DOM nodes
   - Fix: Use stable key string

### Database Query Safety

7. **Missing Timeouts**
   - Location: Throughout `services/shorts/internal/store/shorts/`
   - Issue: Many queries use `context.Background()` without timeout
   - Fix: Add 10-second default timeout

8. **Connection Pool Risk**
   - File: `services/shorts/internal/store/shorts/postgres.go:80-84`
   - Issue: 25 MaxConns × multiple instances > Supabase 60 limit
   - Fix: Document expected replicas, validate limits

### Proto/API Issues

9. **Missing Field Number**
   - File: `proto/shortedtypes/stocks/v1alpha1/stocks.proto`
   - Issue: Field 2 missing in TimeSeriesData (jump from 1 to 3)
   - Fix: Add `reserved 2;`

10. **Unimplemented Service**
    - File: `proto/shortedapi/dashboard/v1/dashboard.proto`
    - Issue: DashboardService fully defined but not implemented
    - Fix: Implement or remove proto

### Dead Code to Remove

- `/cms/` - Abandoned Strapi CMS (last modified April 2024)
- `services/gen/proto/go/user/v1/user.pb.go` - Orphaned generated code
- `proto/empty/empty.proto` - Placeholder with no purpose
- Disabled CI jobs in `.github/workflows/ci.yml`

### Missing Observability (High Priority Backlog)

- No structured logging (using `log.Printf`)
- No distributed tracing (no OpenTelemetry)
- No error tracking (no Sentry)
- No APM solution
- No rate limiting on public APIs

### Simplification Opportunities

1. **Auth Stack**: Firebase + NextAuth + Custom JWT → Just NextAuth + PostgreSQL
2. **Sync Services**: daily-sync + market-data-sync → Single unified service
3. **Database**: PostgreSQL + Firestore → PostgreSQL only
4. **Proto Modules**: 5 modules → Single `shorted.proto`

### File Location Quick Reference

| Category | Key Files |
|----------|-----------|
| Main API handlers | `services/shorts/internal/services/shorts/service.go` |
| Database layer | `services/shorts/internal/store/shorts/postgres.go` |
| Auth middleware | `services/shorts/internal/services/shorts/middleware_connect.go` |
| Frontend API client | `web/src/server/apiClient.ts` |
| Dashboard page | `web/src/app/dashboards/page.tsx` |
| Widget system | `web/src/@/lib/widget-registry.ts` |
| Terraform main | `terraform/environments/dev/main.tf` |
| CI/CD pipeline | `.github/workflows/terraform-deploy.yml` |
