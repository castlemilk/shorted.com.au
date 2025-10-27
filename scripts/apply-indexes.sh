#!/bin/bash
# Apply search indexes migration to Supabase database

set -e

# Database URL with SSL disabled for connection issues
DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres?sslmode=disable"

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
