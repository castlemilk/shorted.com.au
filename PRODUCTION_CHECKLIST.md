# Production Release Checklist

## Pre-Deployment Checklist

### ✅ Critical (Must Complete Before Production)

- [x] **SSR Performance Optimization**
  - [x] Convert `/shorts` page to SSR
  - [x] Convert `/stocks` page to SSR  
  - [x] Add ISR caching to `/shorts/[stockCode]` (1 hour revalidation)
  - **Status**: ✅ Complete - Pages now render on server for 6-10x performance improvement

- [x] **Rate Limiting**
  - [x] Update rate limiting to use Vercel KV (Upstash Redis)
  - [x] Configure distributed rate limiting for API routes
  - **Status**: ✅ Complete - Rate limiting now works across serverless instances
  - **Action Required**: Set `KV_REST_API_URL` and `KV_REST_API_TOKEN` in Vercel

- [ ] **Environment Variables Verification**
  - [ ] Verify all production secrets are set in Vercel:
    - `NEXTAUTH_SECRET` (must be unique for production!)
    - `NEXTAUTH_URL` (must match production domain: `https://shorted.com.au`)
    - `DATABASE_URL` (production Supabase connection string)
    - `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` (with correct redirect URIs)
    - `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Vercel KV credentials)
    - `NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT` (production backend URL)
    - `NEXT_PUBLIC_MARKET_DATA_API_URL` (production market data URL)
  - **Action**: Check Vercel Dashboard → Settings → Environment Variables

- [ ] **Database Optimization**
  - [ ] Set `DATABASE_URL` environment variable (production Supabase connection string)
  - [ ] Install Python dependencies: `pip install asyncpg` (if not already installed)
  - [ ] Run `make db-optimize-full` to apply indexes, update statistics, and validate
  - [ ] Verify all migrations are applied
  - **Action**: 
    ```bash
    export DATABASE_URL="postgresql://user:pass@host:port/db"
    pip install asyncpg  # If needed
    make db-optimize-full
    ```
  - **Expected Output**: All validation tests should pass, queries should complete in < 1 second

- [ ] **Google OAuth Configuration**
  - [ ] Verify OAuth redirect URIs include production domain
  - [ ] Test sign-in flow on production domain
  - **Action**: Check Google Cloud Console → APIs & Services → Credentials

### ⚠️ Important (Should Complete Before Production)

- [ ] **Monitoring & Alerts**
  - [ ] Set up GCP uptime checks for backend services
  - [ ] Configure error rate alerts
  - [ ] Set up database connection monitoring
  - **Action**: Configure in GCP Console → Monitoring

- [ ] **Backup Verification**
  - [ ] Verify Supabase daily backups are enabled
  - [ ] Document restore procedure
  - [ ] Test restore process (optional)
  - **Action**: Check Supabase Dashboard → Database → Backups

- [ ] **Load Testing**
  - [ ] Run basic load test on key endpoints
  - [ ] Verify rate limiting works under load
  - [ ] Check database connection pool limits
  - **Action**: Use k6 or similar tool for quick smoke test

### 📋 Nice to Have (Can Add Post-Launch)

- [ ] Error tracking (Sentry) - Skipped per request
- [ ] Custom domain with SSL
- [ ] Analytics dashboards
- [ ] Performance budgets in CI
- [ ] Blue/green deployment setup

## Deployment Steps

### 1. Pre-Deployment Verification

```bash
# Run all tests locally
make test

# Verify build succeeds
make build

# Check for linting errors
make lint
```

### 2. Verify CI/CD Pipeline

- [ ] Check GitHub Actions workflow passes
- [ ] Verify Terraform plan looks correct
- [ ] Confirm Docker images build successfully
- [ ] Check integration tests pass

### 3. Production Deployment

#### Option A: Automatic (Recommended)
```bash
# Push to main branch
git push origin main

# Monitor deployment in GitHub Actions
# Services will auto-deploy via terraform-deploy.yml
```

#### Option B: Manual Release
```bash
# Create release tag
git tag v1.0.0
git push --tags

# Monitor release workflow
# Terraform will deploy to production environment
```

### 4. Post-Deployment Verification

- [ ] **Health Checks**
  ```bash
  # Backend services
  curl https://shorts-service-xxx.a.run.app/health
  curl https://market-data-service-xxx.a.run.app/health
  
  # Frontend
  curl https://shorted.com.au/api/health
  ```

- [ ] **Smoke Tests**
  - [ ] Homepage loads correctly
  - [ ] Top shorts page loads (requires auth)
  - [ ] Stock search works
  - [ ] Stock detail pages load
  - [ ] Sign-in flow works
  - [ ] API endpoints respond correctly

- [ ] **Performance Check**
  - [ ] Page load times < 2 seconds
  - [ ] API response times < 500ms
  - [ ] No console errors
  - [ ] No 429 rate limit errors (unless testing limits)

## Rollback Plan

### If Issues Detected

1. **Rollback Frontend (Vercel)**
   ```bash
   vercel rollback [deployment-url]
   ```

2. **Rollback Backend (Cloud Run)**
   ```bash
   # List revisions
   gcloud run revisions list --service shorts-service --region australia-southeast2
   
   # Rollback to previous revision
   gcloud run services update-traffic shorts-service \
     --to-revisions PREVIOUS_REVISION=100 \
     --region australia-southeast2
   ```

3. **Rollback Infrastructure (Terraform)**
   ```bash
   cd terraform/environments/prod
   terraform state list
   terraform apply -target=module.shorts_service -auto-approve
   ```

## Environment-Specific Configuration

### Production Environment Variables

| Variable | Value | Notes |
|----------|-------|-------|
| `NEXTAUTH_URL` | `https://shorted.com.au` | Must match production domain |
| `NEXTAUTH_SECRET` | `[unique-secret]` | Generate with `openssl rand -base64 32` |
| `DATABASE_URL` | `postgresql://...` | Production Supabase connection |
| `KV_REST_API_URL` | `https://...` | Vercel KV REST API URL |
| `KV_REST_API_TOKEN` | `[token]` | Vercel KV REST API token |
| `GCP_PROJECT_ID` | `rosy-clover-477102-t5` | Production GCP project |

### Development vs Production

| Component | Dev | Prod |
|-----------|-----|------|
| GCP Project | `shorted-dev-aba5688f` | `rosy-clover-477102-t5` |
| Database | Shared Supabase | Same (verify) |
| Frontend | Vercel Preview | Vercel Production |
| Backend | Cloud Run (dev) | Cloud Run (prod) |
| Rate Limiting | In-memory fallback | Vercel KV |

## Post-Launch Monitoring

### First 24 Hours

- [ ] Monitor error rates
- [ ] Check response times
- [ ] Verify rate limiting is working
- [ ] Monitor database connections
- [ ] Check Cloud Run instance scaling
- [ ] Review Vercel analytics

### First Week

- [ ] Review user feedback
- [ ] Monitor performance metrics
- [ ] Check for any edge cases
- [ ] Verify daily sync jobs run successfully
- [ ] Review cost metrics

## Troubleshooting

### Common Issues

1. **Rate Limiting Not Working**
   - Check `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set
   - Verify Vercel KV is provisioned
   - Check middleware logs

2. **Authentication Issues**
   - Verify `NEXTAUTH_URL` matches production domain
   - Check OAuth redirect URIs in Google Console
   - Verify `NEXTAUTH_SECRET` is set

3. **Database Connection Issues**
   - Verify `DATABASE_URL` is correct
   - Check Supabase connection pool limits
   - Review connection logs

4. **Slow Page Loads**
   - Check ISR cache is working
   - Verify SSR is enabled (check page source)
   - Review Cloud Run instance scaling

## Success Criteria

✅ **Ready for Production When:**
- All critical checklist items complete
- All tests passing
- CI/CD pipeline green
- Environment variables verified
- Health checks passing
- Smoke tests successful

---

**Last Updated**: 2025-01-15
**Status**: Ready for production deployment after completing environment variable verification and database optimization

