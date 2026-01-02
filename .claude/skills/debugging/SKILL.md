---
name: debugging
description: Debug common issues in the Shorted project. Use when troubleshooting errors, fixing bugs, or diagnosing problems with the backend, frontend, or database.
allowed-tools: Read, Bash(make:*), Bash(docker:*), Bash(lsof:*), Bash(curl:*), Bash(psql:*), Grep, Glob
---

# Debugging Guide

This skill helps you diagnose and fix common issues in the Shorted project.

## Quick Diagnostics

```bash
# Check if services are running
make dev-db && docker ps

# Check ports in use
lsof -i :3020  # Frontend
lsof -i :9091  # Backend
lsof -i :5438  # Database

# Kill stale processes
make clean-ports

# Full restart
make dev-stop && make dev
```

## Common Issues

### Backend Not Starting

**Symptom**: `make dev-backend` fails or hangs

**Steps**:

1. Check for port conflicts:
   ```bash
   lsof -i :9091
   ```

2. Kill stale processes:
   ```bash
   make clean-ports
   ```

3. Check database is running:
   ```bash
   docker ps | grep shorted_db
   ```

4. Test database connection:
   ```bash
   psql postgresql://admin:password@localhost:5438/shorts -c "SELECT 1"
   ```

5. Check for Go compilation errors:
   ```bash
   cd services && go build ./shorts/cmd/server/...
   ```

6. Check environment variables:
   ```bash
   echo $DATABASE_URL
   # Should be: postgresql://admin:password@localhost:5438/shorts
   ```

### Frontend Not Starting

**Symptom**: `make dev-frontend` fails

**Steps**:

1. Clear Next.js cache:
   ```bash
   make clean-cache
   ```

2. Reinstall dependencies:
   ```bash
   cd web && rm -rf node_modules && npm install
   ```

3. Check for TypeScript errors:
   ```bash
   cd web && npx tsc --noEmit
   ```

4. Check port availability:
   ```bash
   lsof -i :3020
   ```

### Database Connection Issues

**Symptom**: "connection refused" or timeout errors

**Steps**:

1. Start the database:
   ```bash
   make dev-db
   ```

2. Check container status:
   ```bash
   docker ps
   docker logs shorted_db
   ```

3. Wait for database to be ready:
   ```bash
   until docker exec shorted_db pg_isready -U admin -d shorts; do
     sleep 2
   done
   ```

4. Test connection:
   ```bash
   psql postgresql://admin:password@localhost:5438/shorts -c "\dt"
   ```

5. If container won't start, reset:
   ```bash
   cd analysis/sql && docker compose down -v
   cd analysis/sql && docker compose up -d postgres
   ```

### API Returning 500 Errors

**Symptom**: Backend returns internal server errors

**Steps**:

1. Check backend logs (run in foreground):
   ```bash
   cd services && DATABASE_URL=postgresql://admin:password@localhost:5438/shorts \
     go run shorts/cmd/server/main.go
   ```

2. Test specific endpoint:
   ```bash
   curl -v -X POST http://localhost:9091/v1/topShorts \
     -H "Content-Type: application/json" \
     -d '{"period": "1m", "limit": 10}'
   ```

3. Check database has data:
   ```bash
   psql postgresql://admin:password@localhost:5438/shorts \
     -c "SELECT COUNT(*) FROM shorts"
   ```

4. Verify database schema:
   ```bash
   cd services && make migrate-version
   cd services && make migrate-up
   ```

### Data Not Showing on Frontend

**Symptom**: UI shows empty state or loading forever

**Steps**:

1. Check backend is responding:
   ```bash
   curl http://localhost:9091/health
   ```

2. Test API directly:
   ```bash
   curl -X POST http://localhost:9091/v1/topShorts \
     -H "Content-Type: application/json" \
     -d '{"period": "1m", "limit": 10}' | jq
   ```

3. Check browser console for errors (open DevTools)

4. Check network tab for failed requests

5. Verify environment variables in `.env.local`:
   ```bash
   cat web/.env.local
   # Should have NEXT_PUBLIC_API_URL or similar
   ```

### Integration Tests Failing

**Symptom**: `make test-integration-local` fails

**Steps**:

1. Ensure Docker is running:
   ```bash
   docker info
   ```

2. Clean up old containers:
   ```bash
   docker system prune -f
   ```

3. Run with verbose output:
   ```bash
   cd services && go test -v ./test/integration/... -timeout=20m
   ```

4. Check testcontainer logs in test output

### Slow Database Queries

**Symptom**: API responses take >1 second

**Steps**:

1. Diagnose slow queries:
   ```bash
   make db-diagnose
   ```

2. Apply performance indexes:
   ```bash
   make db-optimize
   ```

3. Update statistics:
   ```bash
   psql postgresql://admin:password@localhost:5438/shorts \
     -c "ANALYZE shorts; ANALYZE \"company-metadata\"; ANALYZE stock_prices;"
   ```

4. Check query plan:
   ```sql
   EXPLAIN ANALYZE
   SELECT * FROM shorts 
   WHERE "PRODUCT_CODE" = 'BHP' 
   ORDER BY "DATE" DESC 
   LIMIT 100;
   ```

### Build/Lint Errors

**Symptom**: `make test` fails on linting

**Steps**:

1. Run linting separately:
   ```bash
   make lint-frontend
   make lint-backend
   ```

2. Auto-fix TypeScript issues:
   ```bash
   cd web && npm run lint -- --fix
   ```

3. Auto-fix Go issues:
   ```bash
   cd services && make lint-fix
   ```

4. Format code:
   ```bash
   make format
   ```

## Debug Mode

### Backend Verbose Logging

```bash
cd services && LOG_LEVEL=debug \
  DATABASE_URL=postgresql://admin:password@localhost:5438/shorts \
  go run shorts/cmd/server/main.go
```

### Frontend Debug

Add to `web/.env.local`:
```
DEBUG=*
```

### PostgreSQL Query Logging

```sql
-- Enable query logging (temporary)
SET log_statement = 'all';
SET log_duration = on;
```

## Health Checks

```bash
# Backend health
curl http://localhost:9091/health

# Database health
docker exec shorted_db pg_isready -U admin -d shorts

# Full system check
make health-check
```

## Log Locations

| Service | How to View |
|---------|-------------|
| Backend | Terminal output (foreground) or `docker logs` |
| Frontend | Terminal output + browser DevTools |
| Database | `docker logs shorted_db` |
| Cloud Run | `make daily-sync-logs` |

## Useful Commands

```bash
# See all running containers
docker ps

# See all processes on common ports
lsof -i :3020,9091,5438,8090

# Database shell
psql postgresql://admin:password@localhost:5438/shorts

# Watch backend logs
cd services && make run.shorts 2>&1 | tee backend.log

# Generate fresh mocks (if tests fail on mock errors)
cd services && go generate ./...
```

