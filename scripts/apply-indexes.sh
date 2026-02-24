#!/bin/bash
# Apply search indexes migration to Supabase database

set -e

# Database URL - must be set via environment variable
if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL environment variable is not set."
    echo "   Export it first: export DATABASE_URL=\"postgresql://user:pass@host:5432/dbname\""
    exit 1
fi

echo "🔧 Applying search indexes migration to Supabase..."

# Check if psql is available
if ! command -v psql &> /dev/null; then
    echo "❌ psql is not installed. Please install PostgreSQL client tools."
    exit 1
fi

# Test connection first
echo "🔍 Testing database connection..."
if ! psql "$DATABASE_URL" -c "SELECT 1;" > /dev/null 2>&1; then
    echo "❌ Failed to connect to database. Please check your connection details."
    exit 1
fi

echo "✅ Database connection successful"

# Apply the migration
echo "📝 Applying migration: 002_add_search_indexes.sql"
if psql "$DATABASE_URL" -f migrations/002_add_search_indexes.sql; then
    echo "✅ Migration applied successfully!"
    
    # Verify indexes were created
    echo "🔍 Verifying indexes were created..."
    psql "$DATABASE_URL" -c "
        SELECT indexname, indexdef 
        FROM pg_indexes 
        WHERE tablename = 'shorts' 
        AND indexname LIKE 'idx_shorts_%'
        ORDER BY indexname;
    "
    
    echo "🎉 Search indexes migration completed successfully!"
else
    echo "❌ Migration failed. Please check the error messages above."
    exit 1
fi
