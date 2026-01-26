#!/bin/bash
set -e

# Database Index Optimization Script
# Safely drops unused indexes to reclaim 337 MB

echo "🔍 Database Index Optimization"
echo "=============================="
echo ""

# Check DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "❌ ERROR: DATABASE_URL environment variable not set"
    echo "   Usage: export DATABASE_URL='postgresql://...'"
    exit 1
fi

echo "📊 Current shorts table size:"
psql "$DATABASE_URL" -c "SELECT pg_size_pretty(pg_total_relation_size('shorts')) as total_size;"
echo ""

echo "📋 Unused indexes to drop (0 uses, 337 MB total):"
psql "$DATABASE_URL" << 'EOF'
SELECT 
    indexrelname as index_name,
    pg_size_pretty(pg_relation_size(indexrelid)) as size,
    idx_scan as times_used
FROM pg_stat_user_indexes
WHERE relname = 'shorts'
  AND idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;
EOF

echo ""
echo "⚠️  This will drop 5 unused indexes and reclaim 337 MB"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Cancelled"
    exit 0
fi

echo ""
echo "🗑️  Dropping unused indexes..."

psql "$DATABASE_URL" << 'EOF'
BEGIN;

-- Drop unused indexes (0 queries use these)
DROP INDEX IF EXISTS idx_shorts_search_composite;
DROP INDEX IF EXISTS idx_shorts_percent_date;
DROP INDEX IF EXISTS idx_shorts_product_code_search;
DROP INDEX IF EXISTS idx_shorts_product_name_search;
DROP INDEX IF EXISTS idx_shorts_percentage_not_null;

-- Show remaining indexes
SELECT 
    COUNT(*) as remaining_indexes,
    pg_size_pretty(SUM(pg_relation_size(indexrelid))) as total_index_size
FROM pg_stat_user_indexes
WHERE relname = 'shorts';

COMMIT;
EOF

echo ""
echo "🧹 Running VACUUM to reclaim space..."
psql "$DATABASE_URL" -c "VACUUM ANALYZE shorts;"

echo ""
echo "✅ Optimization complete!"
echo ""
echo "📊 New shorts table size:"
psql "$DATABASE_URL" -c "SELECT pg_size_pretty(pg_total_relation_size('shorts')) as total_size;"

echo ""
echo "🎉 Done! Indexes optimized successfully."

