# Debugging

Debug common issues in the Shorted project. Use when troubleshooting errors, fixing bugs, or diagnosing problems with the backend, frontend, or database.

## Quick Diagnostics

```bash
# Check services
docker ps
lsof -i :3020,9091,5438

# Kill stale processes
make clean-ports

# Full restart
make dev-stop && make dev
```

## Instructions

### Backend Not Starting

```bash
# Check port
lsof -i :9091

# Kill stale processes
make clean-ports

# Check database
docker ps | grep shorted_db
psql postgresql://admin:password@localhost:5438/shorts -c "SELECT 1"

# Check Go compilation
cd services && go build ./shorts/cmd/server/...
```

### Frontend Not Starting

```bash
# Clear cache
make clean-cache

# Reinstall
cd web && rm -rf node_modules && npm install

# Check TypeScript
cd web && npx tsc --noEmit
```

### Database Issues

```bash
# Start database
make dev-db

# Check container
docker ps
docker logs shorted_db

# Reset database
cd analysis/sql && docker compose down -v
cd analysis/sql && docker compose up -d postgres
```

### API Returning 500

```bash
# Check logs
cd services && DATABASE_URL=postgresql://admin:password@localhost:5438/shorts \
  go run shorts/cmd/server/main.go

# Test endpoint
curl -v -X POST http://localhost:9091/v1/topShorts \
  -H "Content-Type: application/json" \
  -d '{"period": "1m", "limit": 10}'

# Check data exists
psql postgresql://admin:password@localhost:5438/shorts \
  -c "SELECT COUNT(*) FROM shorts"
```

### Slow Queries

```bash
# Diagnose
make db-diagnose

# Apply indexes
make db-optimize

# Update statistics
psql postgresql://admin:password@localhost:5438/shorts \
  -c "ANALYZE shorts; ANALYZE \"company-metadata\";"
```

### Build/Lint Errors

```bash
# Run linting
make lint-frontend
make lint-backend

# Auto-fix
cd web && npm run lint -- --fix
cd services && make lint-fix
```

## Health Checks

```bash
curl http://localhost:9091/health
docker exec shorted_db pg_isready -U admin -d shorts
make health-check
```

## Ports Reference

| Service | Port |
|---------|------|
| Frontend | 3020 |
| Backend | 9091 |
| Market Data | 8090 |
| Database | 5438 |

