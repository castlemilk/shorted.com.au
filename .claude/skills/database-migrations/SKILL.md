---
name: database-migrations
description: Create and manage PostgreSQL database migrations. Use when adding tables, columns, indexes, or modifying the database schema.
allowed-tools: Read, Write, Bash(make:*), Bash(psql:*), Grep, Glob
---

# Database Migrations

This skill guides you through creating and managing database migrations for the Shorted project.

## Quick Reference

```bash
# Create a new migration
cd services && make migrate-create NAME=add_users_table

# Apply pending migrations
cd services && make migrate-up

# Rollback last migration
cd services && make migrate-down

# Check current version
cd services && make migrate-version
```

## Migration Location

Migrations are stored in `services/migrations/` with sequential numbering:

```
services/migrations/
├── 000001_init_schema.up.sql
├── 000001_init_schema.down.sql
├── 000002_add_company_metadata.up.sql
├── 000002_add_company_metadata.down.sql
└── ...
```

## Creating a Migration

### Step 1: Generate Migration Files

```bash
cd services
make migrate-create NAME=add_user_watchlists
```

This creates two files:
- `XXXXXX_add_user_watchlists.up.sql` - Forward migration
- `XXXXXX_add_user_watchlists.down.sql` - Rollback migration

### Step 2: Write the Up Migration

```sql
-- services/migrations/XXXXXX_add_user_watchlists.up.sql

-- Create the watchlists table
CREATE TABLE IF NOT EXISTS user_watchlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'My Watchlist',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create the watchlist items table
CREATE TABLE IF NOT EXISTS watchlist_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    watchlist_id UUID NOT NULL REFERENCES user_watchlists(id) ON DELETE CASCADE,
    stock_code TEXT NOT NULL,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    notes TEXT,
    UNIQUE(watchlist_id, stock_code)
);

-- Add indexes for common queries
CREATE INDEX idx_user_watchlists_user_id ON user_watchlists(user_id);
CREATE INDEX idx_watchlist_items_watchlist_id ON watchlist_items(watchlist_id);
CREATE INDEX idx_watchlist_items_stock_code ON watchlist_items(stock_code);

-- Add trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_user_watchlists_updated_at
    BEFORE UPDATE ON user_watchlists
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

### Step 3: Write the Down Migration

```sql
-- services/migrations/XXXXXX_add_user_watchlists.down.sql

-- Drop in reverse order of creation
DROP TRIGGER IF EXISTS update_user_watchlists_updated_at ON user_watchlists;
DROP FUNCTION IF EXISTS update_updated_at_column();
DROP INDEX IF EXISTS idx_watchlist_items_stock_code;
DROP INDEX IF EXISTS idx_watchlist_items_watchlist_id;
DROP INDEX IF EXISTS idx_user_watchlists_user_id;
DROP TABLE IF EXISTS watchlist_items;
DROP TABLE IF EXISTS user_watchlists;
```

## Common Migration Patterns

### Adding a Column

```sql
-- Up
ALTER TABLE shorts ADD COLUMN source TEXT DEFAULT 'asic';

-- Down
ALTER TABLE shorts DROP COLUMN IF EXISTS source;
```

### Adding an Index

```sql
-- Up
CREATE INDEX CONCURRENTLY idx_shorts_date_product 
ON shorts("DATE", "PRODUCT_CODE");

-- Down
DROP INDEX CONCURRENTLY IF EXISTS idx_shorts_date_product;
```

### Renaming a Column

```sql
-- Up
ALTER TABLE "company-metadata" RENAME COLUMN old_name TO new_name;

-- Down
ALTER TABLE "company-metadata" RENAME COLUMN new_name TO old_name;
```

### Adding a Foreign Key

```sql
-- Up
ALTER TABLE stock_prices 
ADD CONSTRAINT fk_stock_prices_stock_code 
FOREIGN KEY (stock_code) REFERENCES stocks(code);

-- Down
ALTER TABLE stock_prices 
DROP CONSTRAINT IF EXISTS fk_stock_prices_stock_code;
```

## Database Connection

### Local Development

```
Host:     localhost:5438
Database: shorts
Username: admin
Password: password
```

```bash
# Connect directly
psql postgresql://admin:password@localhost:5438/shorts

# Or use make target
make dev-db  # Ensure database is running first
```

### Production

Production migrations require the `DATABASE_URL` environment variable:

```bash
export DATABASE_URL='postgresql://user:pass@host:5432/database'
cd services && make migrate-up-prod
```

## Testing Migrations

### Test Locally

```bash
# Start the database
make dev-db

# Apply migration
cd services && make migrate-up

# Verify tables exist
psql postgresql://admin:password@localhost:5438/shorts -c "\dt"

# Test rollback
cd services && make migrate-down

# Re-apply
cd services && make migrate-up
```

### Check Migration Status

```bash
cd services && make migrate-version
```

## Best Practices

### DO:
- Always write both up and down migrations
- Use `IF EXISTS` / `IF NOT EXISTS` for idempotency
- Use `CONCURRENTLY` for index creation on large tables
- Test migrations locally before applying to production
- Keep migrations small and focused
- Add comments explaining complex changes

### DON'T:
- Don't modify existing migration files after they're committed
- Don't drop columns without a migration plan
- Don't use raw `DELETE` or `UPDATE` - use explicit transactions
- Don't forget to update the Go store interfaces if schema changes

## Troubleshooting

### Migration Stuck

```bash
# Force set version (use with caution!)
cd services && make migrate-force VERSION=X
```

### Dirty Database State

If a migration failed partway through:

```bash
# Check current state
cd services && make migrate-version

# Force to last known good version
cd services && make migrate-force VERSION=X

# Then retry
cd services && make migrate-up
```

### View Migration History

```sql
SELECT * FROM schema_migrations ORDER BY version;
```

