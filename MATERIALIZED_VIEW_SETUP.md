# Materialized View Setup Guide

## Overview

This guide explains how to apply and manage the treemap materialized view migration in Supabase.

---

## Quick Start

### 1. Apply Migration

```bash
cd /Users/benebsworth/projects/shorted

# Using Supabase CLI (recommended)
supabase db push

# Or manually via psql
export DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres"
psql "$DATABASE_URL" < supabase/migrations/004_treemap_materialized_view.sql
```

### 2. Verify Installation

```sql
-- Check if view exists
SELECT 
    COUNT(*) as total_rows,
    COUNT(DISTINCT period_name) as periods,
    COUNT(DISTINCT industry) as industries,
    MAX(last_refreshed) as last_refresh
FROM mv_treemap_data;
```

Expected result:
```
total_rows | periods | industries | last_refresh
-----------+---------+------------+-------------------------
5863       | 6       | 27         | 2025-11-09 11:16:57...
```

### 3. Setup Automated Refresh

Add to your daily data pipeline:

```bash
# After loading new shorts data, refresh the view
./scripts/refresh-materialized-views.sh
```

---

## Files Created

```
supabase/migrations/
├── 004_treemap_materialized_view.sql       -- Main migration
└── 004_treemap_materialized_view_down.sql  -- Rollback migration

scripts/
└── refresh-materialized-views.sh            -- Refresh script

Documentation/
├── TREEMAP_MATERIALIZED_VIEW.md            -- Technical details
└── MATERIALIZED_VIEW_SETUP.md              -- This file
```

---

## Using Supabase CLI

### Initial Setup

```bash
# Install Supabase CLI if not already installed
brew install supabase/tap/supabase

# Login to Supabase
supabase login

# Link to your project
cd /Users/benebsworth/projects/shorted
supabase link --project-ref xivfykscsdagwsreyqgf
```

### Apply Migration

```bash
# Check status
supabase db diff

# Apply all pending migrations
supabase db push

# Or apply specific migration
supabase db push --include 004_treemap_materialized_view
```

### Verify

```bash
# Check migration history
supabase migration list

# Connect to database
supabase db shell

# Then run:
SELECT * FROM mv_treemap_data LIMIT 5;
```

---

## Manual Application

If you prefer manual application or don't have Supabase CLI:

### Apply Migration

```bash
export DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres"

# Apply the migration
psql "$DATABASE_URL" -f supabase/migrations/004_treemap_materialized_view.sql

# Verify
psql "$DATABASE_URL" -c "SELECT COUNT(*), MAX(last_refreshed) FROM mv_treemap_data;"
```

### Rollback (if needed)

```bash
# Rollback the migration
psql "$DATABASE_URL" -f supabase/migrations/004_treemap_materialized_view_down.sql
```

---

## Automated Refresh Setup

### Option 1: Cron Job

```bash
# Make script executable
chmod +x scripts/refresh-materialized-views.sh

# Add to crontab (daily at 3 AM, after shorts data load)
crontab -e

# Add this line:
0 3 * * * cd /path/to/shorted && export DATABASE_URL="postgresql://..." && ./scripts/refresh-materialized-views.sh >> /var/log/treemap-refresh.log 2>&1
```

### Option 2: GitHub Actions

Create `.github/workflows/refresh-treemap.yml`:

```yaml
name: Refresh Materialized Views

on:
  schedule:
    - cron: '0 3 * * *'  # Daily at 3 AM UTC
  workflow_dispatch:      # Manual trigger

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Refresh materialized views
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: |
          chmod +x scripts/refresh-materialized-views.sh
          ./scripts/refresh-materialized-views.sh
```

### Option 3: Supabase Edge Function

Create a Supabase Edge Function that refreshes the view:

```typescript
// supabase/functions/refresh-treemap/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // Refresh the materialized view
  const { error } = await supabase.rpc('refresh_treemap_data')
  
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

Then trigger it via cron or webhook.

### Option 4: Add to Data Pipeline

If you have a data loading service, add the refresh:

```python
# After loading shorts data
import asyncpg

async def refresh_views(db_url: str):
    conn = await asyncpg.connect(db_url)
    try:
        await conn.execute("SELECT refresh_treemap_data()")
        print("✅ Materialized views refreshed")
    finally:
        await conn.close()

# In your main data pipeline
await load_shorts_data()
await refresh_views(DATABASE_URL)
```

---

## Monitoring

### Check Freshness

```sql
SELECT 
    MAX(last_refreshed) as last_refresh,
    AGE(NOW(), MAX(last_refreshed)) as time_since_refresh,
    CASE 
        WHEN AGE(NOW(), MAX(last_refreshed)) > INTERVAL '25 hours' THEN '⚠️ STALE'
        ELSE '✅ FRESH'
    END as status
FROM mv_treemap_data;
```

### Check Size

```sql
SELECT 
    pg_size_pretty(pg_total_relation_size('mv_treemap_data')) as total_size,
    pg_size_pretty(pg_relation_size('mv_treemap_data')) as data_size,
    pg_size_pretty(pg_total_relation_size('mv_treemap_data') - pg_relation_size('mv_treemap_data')) as indexes_size;
```

### Check Performance

```sql
EXPLAIN ANALYZE
SELECT * FROM get_treemap_data('3m', 10, 'percentage_change')
LIMIT 100;
```

Expected: **< 2ms execution time**

---

## Troubleshooting

### Migration Already Applied

If you see "relation already exists":

```sql
-- Check current state
\d+ mv_treemap_data

-- If correct, mark migration as applied
-- (specific to your migration tracking system)
```

### Connection Limit Errors

Use port **6543** (transaction mode) instead of **5432** (session mode):

```bash
# ✅ Good
postgresql://...@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres

# ❌ Avoid
postgresql://...@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres
```

### Refresh Takes Too Long

```sql
-- Check if refresh is running
SELECT * FROM pg_stat_activity 
WHERE query LIKE '%REFRESH MATERIALIZED VIEW%';

-- If stuck, cancel it
SELECT pg_cancel_backend(pid) 
FROM pg_stat_activity 
WHERE query LIKE '%REFRESH MATERIALIZED VIEW%';

-- Try again
SELECT refresh_treemap_data();
```

### Out of Date Data

```sql
-- Force refresh immediately
SELECT refresh_treemap_data();

-- Then check
SELECT MAX(last_refreshed), AGE(NOW(), MAX(last_refreshed))
FROM mv_treemap_data;
```

---

## Rollback

If you need to remove the materialized view:

### Using Supabase CLI

```bash
supabase db reset
# Or
supabase migration down
```

### Manual Rollback

```bash
export DATABASE_URL="postgresql://..."
psql "$DATABASE_URL" -f supabase/migrations/004_treemap_materialized_view_down.sql
```

---

## Performance Comparison

| Operation | Before | After | Improvement |
|-----------|--------|-------|-------------|
| Treemap query | 11,007 ms | 1.3 ms | **8,500x faster** |
| View size | N/A | 1.4 MB | Minimal |
| Refresh time | N/A | ~30s | Once daily |
| Server load | High | Minimal | **99% reduction** |

---

## Checklist

- [ ] Migration file created (`004_treemap_materialized_view.sql`)
- [ ] Rollback file created (`004_treemap_materialized_view_down.sql`)
- [ ] Migration applied to Supabase
- [ ] Materialized view verified (5000+ rows)
- [ ] Indexes created (4 indexes)
- [ ] Helper functions working
- [ ] Refresh script created
- [ ] Automated refresh scheduled
- [ ] Backend code updated to use materialized view
- [ ] Performance verified (< 2ms queries)
- [ ] Monitoring setup
- [ ] Documentation complete

---

## Next Steps

1. ✅ **Migration files created**
2. ⏳ **Apply migration** (use Supabase CLI or psql)
3. ⏳ **Setup automated refresh** (cron/workflow/edge function)
4. ⏳ **Update Go backend** to query `mv_treemap_data` instead of complex query
5. ⏳ **Deploy and test**
6. ⏳ **Monitor performance** and freshness

---

## Support

If you encounter issues:

1. Check the logs: `supabase logs db`
2. Verify connection: `supabase db shell`
3. Check refresh status: `SELECT * FROM mv_treemap_data LIMIT 1`
4. Review documentation: `TREEMAP_MATERIALIZED_VIEW.md`

**Status:** ✅ Ready to apply

