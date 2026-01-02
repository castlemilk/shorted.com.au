# Database Migrations

Create and manage PostgreSQL database migrations. Use when adding tables, columns, indexes, or modifying the database schema.

## Quick Commands

```bash
cd services

# Create migration
make migrate-create NAME=add_users_table

# Apply migrations
make migrate-up

# Rollback
make migrate-down

# Check version
make migrate-version
```

## Instructions

### Creating a Migration

```bash
cd services && make migrate-create NAME=add_user_watchlists
```

Creates two files in `services/migrations/`:
- `XXXXXX_add_user_watchlists.up.sql`
- `XXXXXX_add_user_watchlists.down.sql`

### Up Migration Example

```sql
-- Create table
CREATE TABLE IF NOT EXISTS user_watchlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'My Watchlist',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes
CREATE INDEX idx_user_watchlists_user_id ON user_watchlists(user_id);
```

### Down Migration Example

```sql
-- Drop in reverse order
DROP INDEX IF EXISTS idx_user_watchlists_user_id;
DROP TABLE IF EXISTS user_watchlists;
```

### Common Patterns

**Add column:**
```sql
ALTER TABLE shorts ADD COLUMN source TEXT DEFAULT 'asic';
```

**Add index (large tables):**
```sql
CREATE INDEX CONCURRENTLY idx_shorts_date ON shorts("DATE");
```

**Add foreign key:**
```sql
ALTER TABLE items ADD CONSTRAINT fk_items_parent 
FOREIGN KEY (parent_id) REFERENCES parents(id);
```

## Database Connection

Local development:
```
postgresql://admin:password@localhost:5438/shorts
```

## Best Practices

- Always write both up and down migrations
- Use `IF EXISTS` / `IF NOT EXISTS` for idempotency
- Use `CONCURRENTLY` for indexes on large tables
- Test migrations locally before production
- Never modify committed migration files

