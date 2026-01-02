#!/bin/bash
# Refresh all materialized views
# This should be run daily after shorts data is loaded

set -e

echo "🔄 Refreshing Materialized Views"
echo "================================="

# Check DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "❌ ERROR: DATABASE_URL environment variable not set"
    echo "   Usage: export DATABASE_URL='postgresql://...'"
    exit 1
fi

# Use transaction mode pooling (port 6543) to avoid connection limits
DATABASE_URL_TRANSACTION="${DATABASE_URL/:5432\//:6543\/}"

echo "📊 Refreshing treemap materialized view..."
echo ""

# Refresh the materialized view
psql "$DATABASE_URL_TRANSACTION" << 'EOF'
-- Show status before refresh
SELECT 
    'BEFORE REFRESH' as status,
    MAX(last_refreshed) as last_refresh,
    AGE(NOW(), MAX(last_refreshed)) as time_since_refresh,
    COUNT(*) as total_rows,
    COUNT(DISTINCT period_name) as periods,
    COUNT(DISTINCT industry) as industries
FROM mv_treemap_data;

-- Refresh the view
SELECT refresh_treemap_data();

-- Show status after refresh
SELECT 
    'AFTER REFRESH' as status,
    MAX(last_refreshed) as last_refresh,
    AGE(NOW(), MAX(last_refreshed)) as time_since_refresh,
    COUNT(*) as total_rows,
    COUNT(DISTINCT period_name) as periods,
    COUNT(DISTINCT industry) as industries
FROM mv_treemap_data;

-- Verify data freshness
SELECT 
    period_name,
    COUNT(DISTINCT product_code) as stocks,
    COUNT(DISTINCT industry) as industries,
    MIN(percentage_change) as min_change,
    MAX(percentage_change) as max_change
FROM mv_treemap_data
GROUP BY period_name
ORDER BY 
    CASE period_name
        WHEN '3m' THEN 1
        WHEN '6m' THEN 2
        WHEN '1y' THEN 3
        WHEN '2y' THEN 4
        WHEN '5y' THEN 5
        WHEN 'max' THEN 6
    END;
EOF

echo ""
echo "✅ Materialized views refreshed successfully!"
echo ""
echo "📈 View size and performance:"
psql "$DATABASE_URL_TRANSACTION" << 'EOF'
SELECT 
    pg_size_pretty(pg_total_relation_size('mv_treemap_data')) as total_size,
    pg_size_pretty(pg_relation_size('mv_treemap_data')) as data_size,
    pg_size_pretty(pg_total_relation_size('mv_treemap_data') - pg_relation_size('mv_treemap_data')) as indexes_size;
EOF

echo ""
echo "🎉 Done!"

