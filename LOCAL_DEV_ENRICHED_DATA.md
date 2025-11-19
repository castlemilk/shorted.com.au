# Local Development with Enriched Company Data

## 🎯 Overview

This guide explains how to use enriched company metadata (GPT-5 generated) in your local development environment.

## ✅ Setup Complete

- ✅ Local PostgreSQL running on port 5438
- ✅ Migrations applied (002, 003, 004)
- ✅ Sync script created
- ✅ Ready for local development

---

## 📋 Prerequisites

1. **Local PostgreSQL running**:
   ```bash
   docker ps | grep postgres
   # Should show shorted_db container
   ```

2. **Migrations applied** (done by sync script):
   - `002_enrich_company_metadata.sql` - Enrichment columns
   - `003_add_financial_statements.sql` - Yahoo Finance data
   - `004_add_financial_reports_storage.sql` - Report tracking

---

## 🔄 Syncing Enriched Data

### Quick Sync (Recommended for Development)

Sync 10 enriched companies from remote to local:

```bash
cd /Users/benebsworth/projects/shorted
./analysis/sync-to-local-db.sh --limit 10
```

### Full Sync

Sync all enriched companies:

```bash
./analysis/sync-to-local-db.sh
```

### Dry Run (Preview)

See what would be synced without making changes:

```bash
./analysis/sync-to-local-db.sh --dry-run --limit 10
```

---

## 🔧 Configuration

### Option 1: Use Local Database (Recommended for Dev)

Update `web/.env.local`:

```bash
# Use local database
DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"

# API endpoints (if running locally)
NEXT_PUBLIC_SHORTS_API_URL="http://localhost:9091"
NEXT_PUBLIC_MARKET_DATA_API_URL="http://localhost:8090"
```

### Option 2: Use Remote Database (For Testing Production Data)

```bash
# Use remote database (Supabase)
DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"
```

### Option 3: Environment-Based (Best Practice)

```bash
# web/.env.local (local development)
DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"

# web/.env.production (production - Vercel)
DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:..."
```

---

## 🚀 Development Workflow

### 1. Start Local Services

```bash
# Terminal 1: Start local database (if not running)
cd analysis/sql
docker compose up -d postgres

# Terminal 2: Start backend services (optional)
cd services
make run.shorts        # Shorts API on :9091
make run.market-data   # Market Data API on :8090

# Terminal 3: Start web app
cd web
npm run dev            # Web app on :3020
```

### 2. Verify Enriched Data

```bash
# Check local database
psql "postgresql://admin:password@localhost:5438/shorts" -c "
SELECT stock_code, company_name, enrichment_status, array_length(tags, 1) as tags
FROM \"company-metadata\"
WHERE enrichment_status = 'completed'
LIMIT 5;
"
```

### 3. Test in Browser

Visit enriched stock pages:
- http://localhost:3020/shorts/WES (Wesfarmers)
- http://localhost:3020/shorts/BHP (BHP Group)
- http://localhost:3020/shorts/CBA (Commonwealth Bank)

You should see:
- ✅ Industry tags
- ✅ Enhanced AI summary
- ✅ Key people with avatars
- ✅ Risk factors
- ✅ Recent developments

---

## 🔄 Keeping Local Data Updated

### When to Re-sync

Re-sync when:
1. New companies are enriched on remote
2. Enrichment data is updated
3. You want to test with latest data

### How to Re-sync

```bash
# Sync latest enriched data
./analysis/sync-to-local-db.sh --limit 20

# Or sync all
./analysis/sync-to-local-db.sh
```

The script uses **upsert** pattern:
- Updates existing companies
- Inserts new companies
- Safe to run multiple times

---

## 📊 Data in Local Database

### Check Enriched Companies

```bash
psql "postgresql://admin:password@localhost:5438/shorts" -c "
SELECT 
    COUNT(*) FILTER (WHERE enrichment_status = 'completed') as enriched,
    COUNT(*) FILTER (WHERE enrichment_status = 'pending') as pending,
    COUNT(*) as total
FROM \"company-metadata\";
"
```

### View Sample Data

```bash
psql "postgresql://admin:password@localhost:5438/shorts" -c "
SELECT 
    stock_code,
    company_name,
    tags,
    LENGTH(enhanced_summary) as summary_length,
    jsonb_array_length(key_people) as people_count
FROM \"company-metadata\"
WHERE enrichment_status = 'completed'
LIMIT 3;
"
```

### Check Specific Company

```bash
psql "postgresql://admin:password@localhost:5438/shorts" -c "
SELECT * FROM \"company-metadata\" WHERE stock_code = 'WES';
" -x
```

---

## 🧪 Testing

### Unit Tests

```bash
cd web
npm test -- company-metadata.test.ts
```

### E2E Tests (with local data)

```bash
# Ensure local database has enriched data
cd web
npm run test:e2e -- enriched-stock-page.spec.ts
```

---

## 🐛 Troubleshooting

### "company-metadata table does not exist"

```bash
# Apply migrations
psql "postgresql://admin:password@localhost:5438/shorts" -f supabase/migrations/002_enrich_company_metadata.sql
psql "postgresql://admin:password@localhost:5438/shorts" -f supabase/migrations/003_add_financial_statements.sql
psql "postgresql://admin:password@localhost:5438/shorts" -f supabase/migrations/004_add_financial_reports_storage.sql
```

### "No enriched data in local database"

```bash
# Sync from remote
./analysis/sync-to-local-db.sh --limit 10
```

### Web app can't connect to database

Check `web/.env.local`:
```bash
cat web/.env.local | grep DATABASE_URL
```

Should show:
```
DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"
```

### Local PostgreSQL not running

```bash
cd analysis/sql
docker compose up -d postgres

# Wait for it to be ready
docker logs shorted_db
```

---

## 📁 File Reference

### Sync Script
```
analysis/sync-to-local-db.sh
```
- Applies migrations
- Exports from remote
- Imports to local (upsert)
- Verifies data

### Migrations
```
supabase/migrations/
├── 002_enrich_company_metadata.sql  # Enrichment columns
├── 003_add_financial_statements.sql # Yahoo Finance data
└── 004_add_financial_reports_storage.sql  # Report tracking
```

### Database Config
```
analysis/sql/docker-compose.yaml  # PostgreSQL container
```

### Web Config
```
web/.env.local  # Local environment variables
```

---

## 🎯 Benefits of Local Development

### ✅ Advantages

1. **Fast Iteration**: No network latency
2. **Offline Development**: Works without internet
3. **Safe Testing**: Can't break production data
4. **Cost Savings**: No database egress fees
5. **Full Control**: Can reset/modify data freely

### ⚠️ Limitations

1. **Data Freshness**: Must sync to get latest enrichments
2. **Initial Setup**: Requires running sync script
3. **Storage**: ~100MB for enriched metadata

---

## 🚀 Quick Start Commands

```bash
# 1. Ensure local database is running
docker ps | grep postgres

# 2. Sync enriched data (first time or to update)
./analysis/sync-to-local-db.sh --limit 10

# 3. Configure web app for local database
echo 'DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"' >> web/.env.local

# 4. Start web app
cd web && npm run dev

# 5. Visit enriched stock page
open http://localhost:3020/shorts/WES
```

---

## 📊 Sync Status

Last synced: Run `./analysis/sync-to-local-db.sh --dry-run` to check

Companies available locally:
```bash
psql "postgresql://admin:password@localhost:5438/shorts" -t -c "
SELECT COUNT(*) FROM \"company-metadata\" WHERE enrichment_status = 'completed';
"
```

---

## 🎉 Ready!

Your local development environment is now set up with enriched company metadata!

**Next**: Start developing with `npm run dev` and visit `/shorts/WES` to see enriched data in action! 🚀

