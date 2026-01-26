#!/usr/bin/env python3
"""
Diagnose slow queries and missing indexes.
This script checks current indexes and simulates the queries used by treemap and top shorts.
"""

import os
import sys
import asyncio
import asyncpg
import logging
from datetime import datetime

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


async def diagnose():
    """Diagnose database performance issues."""

    # Try to get database URL from environment
    database_url = os.getenv("SUPABASE_DB_URL") or os.getenv("DATABASE_URL")
    
    if not database_url:
        logger.error("❌ DATABASE_URL or SUPABASE_DB_URL environment variable is required")
        return False

    try:
        logger.info("🔌 Connecting to database...")
        # Disable statement cache for pgbouncer compatibility
        conn = await asyncpg.connect(database_url, statement_cache_size=0)
        logger.info("✅ Connected successfully\n")

        # 1. Check existing indexes
        logger.info("=" * 80)
        logger.info("📑 EXISTING INDEXES ON 'shorts' TABLE")
        logger.info("=" * 80)
        
        shorts_indexes = await conn.fetch(
            """
            SELECT 
                indexname,
                indexdef,
                pg_size_pretty(pg_relation_size(indexname::regclass)) as size
            FROM pg_indexes 
            WHERE tablename = 'shorts' 
            ORDER BY indexname
        """
        )

        if shorts_indexes:
            for row in shorts_indexes:
                logger.info(f"\n{row['indexname']} ({row['size']})")
                logger.info(f"  {row['indexdef']}")
        else:
            logger.warning("⚠️  No indexes found on 'shorts' table!")

        # 2. Check company-metadata indexes
        logger.info("\n" + "=" * 80)
        logger.info("📑 EXISTING INDEXES ON 'company-metadata' TABLE")
        logger.info("=" * 80)
        
        metadata_indexes = await conn.fetch(
            """
            SELECT 
                indexname,
                indexdef,
                pg_size_pretty(pg_relation_size(indexname::regclass)) as size
            FROM pg_indexes 
            WHERE tablename = 'company-metadata' 
            ORDER BY indexname
        """
        )

        if metadata_indexes:
            for row in metadata_indexes:
                logger.info(f"\n{row['indexname']} ({row['size']})")
                logger.info(f"  {row['indexdef']}")
        else:
            logger.warning("⚠️  No indexes found on 'company-metadata' table!")

        # 3. Get table sizes
        logger.info("\n" + "=" * 80)
        logger.info("📊 TABLE STATISTICS")
        logger.info("=" * 80)
        
        table_stats = await conn.fetch(
            """
            SELECT 
                tablename,
                pg_size_pretty(pg_total_relation_size('public.'||tablename)) as total_size,
                pg_size_pretty(pg_relation_size('public.'||tablename)) as table_size,
                pg_size_pretty(pg_total_relation_size('public.'||tablename) - 
                              pg_relation_size('public.'||tablename)) as indexes_size
            FROM pg_tables
            WHERE tablename IN ('shorts', 'company-metadata')
            AND schemaname = 'public'
        """
        )

        for row in table_stats:
            logger.info(f"\n{row['tablename']}:")
            logger.info(f"  Table size:   {row['table_size']}")
            logger.info(f"  Indexes size: {row['indexes_size']}")
            logger.info(f"  Total size:   {row['total_size']}")

        # 4. Get row counts
        shorts_count = await conn.fetchval('SELECT COUNT(*) FROM shorts')
        metadata_count = await conn.fetchval('SELECT COUNT(*) FROM "company-metadata"')
        
        logger.info(f"\nshorts: {shorts_count:,} rows")
        logger.info(f"company-metadata: {metadata_count:,} rows")

        # 5. Test query performance with EXPLAIN ANALYZE
        logger.info("\n" + "=" * 80)
        logger.info("⚡ QUERY PERFORMANCE ANALYSIS")
        logger.info("=" * 80)

        # Test 1: Top shorts query (first part - finding top codes)
        logger.info("\n🔍 Test 1: Top Shorts - Latest Data Query")
        logger.info("-" * 80)
        
        start_time = datetime.now()
        explain_result = await conn.fetch(
            """
            EXPLAIN ANALYZE
            WITH max_date AS (
                SELECT MAX("DATE") as latest_date FROM shorts
            ),
            latest_shorts AS (
                SELECT "PRODUCT_CODE", "PRODUCT", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
                FROM shorts, max_date
                WHERE "DATE" = max_date.latest_date
                  AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
            )
            SELECT "PRODUCT", "PRODUCT_CODE"
            FROM latest_shorts
            ORDER BY "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
            LIMIT 10
        """
        )
        elapsed = (datetime.now() - start_time).total_seconds()
        
        for row in explain_result:
            logger.info(row[0])
        logger.info(f"\n⏱️  Query time: {elapsed:.3f}s")

        # Test 2: Treemap query (current shorts)
        logger.info("\n🔍 Test 2: Treemap - Current Shorts Query (3 months)")
        logger.info("-" * 80)
        
        start_time = datetime.now()
        explain_result = await conn.fetch(
            """
            EXPLAIN ANALYZE
            WITH latest_short_positions AS (
                SELECT 
                    "PRODUCT_CODE",
                    MAX("DATE") AS max_date
                FROM 
                    public.shorts
                WHERE 
                    "DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '3 months'
                GROUP BY 
                    "PRODUCT_CODE"
                HAVING MAX("DATE") >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '6 months'
            ),
            current_short_positions AS (
                SELECT 
                    lsp."PRODUCT_CODE",
                    s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS current_short_position
                FROM 
                    latest_short_positions lsp
                JOIN 
                    public.shorts s
                ON 
                    lsp."PRODUCT_CODE" = s."PRODUCT_CODE" AND lsp.max_date = s."DATE"
            ),
            ranked_stocks AS (
                SELECT 
                    cm.industry,
                    csp."PRODUCT_CODE",
                    csp.current_short_position,
                    ROW_NUMBER() OVER (PARTITION BY cm.industry ORDER BY csp.current_short_position DESC) AS rank
                FROM 
                    current_short_positions csp
                JOIN 
                    public."company-metadata" cm
                ON 
                    csp."PRODUCT_CODE" = cm.stock_code
            )
            SELECT 
                industry,
                "PRODUCT_CODE",
                current_short_position
            FROM 
                ranked_stocks
            WHERE 
                rank <= 10
            ORDER BY 
                industry,
                current_short_position DESC
        """
        )
        elapsed = (datetime.now() - start_time).total_seconds()
        
        for row in explain_result:
            logger.info(row[0])
        logger.info(f"\n⏱️  Query time: {elapsed:.3f}s")

        # 6. Check for missing statistics
        logger.info("\n" + "=" * 80)
        logger.info("📈 TABLE STATISTICS STATUS")
        logger.info("=" * 80)
        
        stats_status = await conn.fetch(
            """
            SELECT 
                schemaname,
                tablename,
                last_analyze,
                last_autoanalyze
            FROM pg_stat_user_tables
            WHERE tablename IN ('shorts', 'company-metadata')
        """
        )

        for row in stats_status:
            logger.info(f"\n{row['tablename']}:")
            logger.info(f"  Last ANALYZE: {row['last_analyze']}")
            logger.info(f"  Last Auto-ANALYZE: {row['last_autoanalyze']}")

        await conn.close()
        
        logger.info("\n" + "=" * 80)
        logger.info("🎯 RECOMMENDATIONS")
        logger.info("=" * 80)
        logger.info("\n1. If queries are slow (>1 second), run:")
        logger.info("   python3 scripts/apply-performance-indexes.py")
        logger.info("\n2. If indexes exist but queries are still slow, run:")
        logger.info("   ANALYZE shorts; ANALYZE \"company-metadata\";")
        logger.info("\n3. Check the EXPLAIN ANALYZE output above for:")
        logger.info("   - Sequential Scans (Seq Scan) - indicates missing indexes")
        logger.info("   - High cost numbers - indicates inefficient query plans")
        logger.info("   - Index Scan vs Bitmap Index Scan - shows index usage")
        
        return True

    except Exception as e:
        logger.error(f"❌ Error during diagnosis: {e}")
        import traceback
        traceback.print_exc()
        return False


async def main():
    """Main function."""
    success = await diagnose()
    if success:
        logger.info("\n✅ Diagnosis completed!")
        sys.exit(0)
    else:
        logger.error("\n❌ Diagnosis failed!")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

