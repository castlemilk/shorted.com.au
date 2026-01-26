#!/usr/bin/env python3
"""
Comprehensive database optimization script.
Applies indexes, updates statistics, and validates optimizations.
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


async def check_connection(database_url: str) -> asyncpg.Connection:
    """Check database connection and return connection."""
    logger.info("🔌 Connecting to database...")
    try:
        conn = await asyncpg.connect(database_url, statement_cache_size=0)
        logger.info("✅ Connected successfully")
        return conn
    except Exception as e:
        logger.error(f"❌ Failed to connect: {e}")
        raise


async def apply_indexes(conn: asyncpg.Connection) -> bool:
    """Apply performance indexes."""
    logger.info("\n" + "=" * 80)
    logger.info("⚡ STEP 1: APPLYING PERFORMANCE INDEXES")
    logger.info("=" * 80)
    
    migration_file = "supabase/migrations/003_add_performance_indexes.sql"
    
    if not os.path.exists(migration_file):
        logger.error(f"❌ Migration file not found: {migration_file}")
        return False
    
    try:
        logger.info(f"📝 Reading migration file: {migration_file}")
        with open(migration_file, "r") as f:
            migration_sql = f.read()
        
        logger.info("⚡ Creating performance indexes...")
        await conn.execute(migration_sql)
        logger.info("✅ Indexes created successfully")
        
        # Verify indexes were created
        logger.info("\n🔍 Verifying indexes...")
        
        shorts_indexes = await conn.fetch(
            """
            SELECT 
                indexname, 
                pg_size_pretty(pg_relation_size(indexname::regclass)) as size
            FROM pg_indexes 
            WHERE tablename = 'shorts' 
            AND (
                indexname LIKE 'idx_shorts_date_product%' OR
                indexname LIKE 'idx_shorts_percent_date%' OR
                indexname LIKE 'idx_shorts_timeseries%' OR
                indexname LIKE 'idx_shorts_product_date_for%'
            )
            ORDER BY indexname
        """
        )
        
        logger.info(f"✅ Found {len(shorts_indexes)} performance indexes on 'shorts' table:")
        for row in shorts_indexes:
            logger.info(f"  - {row['indexname']} ({row['size']})")
        
        metadata_indexes = await conn.fetch(
            """
            SELECT 
                indexname,
                pg_size_pretty(pg_relation_size(indexname::regclass)) as size
            FROM pg_indexes 
            WHERE tablename = 'company-metadata' 
            AND indexname LIKE 'idx_company_metadata%'
            ORDER BY indexname
        """
        )
        
        logger.info(f"✅ Found {len(metadata_indexes)} performance indexes on 'company-metadata' table:")
        for row in metadata_indexes:
            logger.info(f"  - {row['indexname']} ({row['size']})")
        
        return True
        
    except Exception as e:
        logger.error(f"❌ Failed to apply indexes: {e}")
        import traceback
        traceback.print_exc()
        return False


async def update_statistics(conn: asyncpg.Connection) -> bool:
    """Update database statistics."""
    logger.info("\n" + "=" * 80)
    logger.info("📊 STEP 2: UPDATING DATABASE STATISTICS")
    logger.info("=" * 80)
    
    try:
        logger.info("📈 Running ANALYZE on 'shorts' table...")
        await conn.execute("ANALYZE shorts")
        logger.info("✅ ANALYZE completed for 'shorts'")
        
        logger.info("📈 Running ANALYZE on 'company-metadata' table...")
        await conn.execute('ANALYZE "company-metadata"')
        logger.info("✅ ANALYZE completed for 'company-metadata'")
        
        # Check statistics status
        stats_status = await conn.fetch(
            """
            SELECT 
                relname as tablename,
                last_analyze,
                last_autoanalyze,
                n_live_tup as row_count
            FROM pg_stat_user_tables
            WHERE relname IN ('shorts', 'company-metadata')
            ORDER BY relname
        """
        )
        
        logger.info("\n📊 Statistics updated:")
        for row in stats_status:
            logger.info(f"\n  {row['tablename']}:")
            logger.info(f"    Rows: {row['row_count']:,}")
            logger.info(f"    Last ANALYZE: {row['last_analyze'] or 'Never'}")
            logger.info(f"    Last Auto-ANALYZE: {row['last_autoanalyze'] or 'Never'}")
        
        return True
        
    except Exception as e:
        logger.error(f"❌ Failed to update statistics: {e}")
        import traceback
        traceback.print_exc()
        return False


async def validate_optimizations(conn: asyncpg.Connection) -> bool:
    """Validate that optimizations are working."""
    logger.info("\n" + "=" * 80)
    logger.info("✅ STEP 3: VALIDATING OPTIMIZATIONS")
    logger.info("=" * 80)
    
    validation_passed = True
    
    # Test 1: Check indexes exist
    logger.info("\n🔍 Test 1: Verifying indexes exist...")
    required_indexes = [
        "idx_shorts_date_product_percent",
        "idx_shorts_product_date_for_windows",
        "idx_company_metadata_stock_industry",
    ]
    
    existing_indexes = await conn.fetch(
        """
        SELECT indexname 
        FROM pg_indexes 
        WHERE tablename IN ('shorts', 'company-metadata')
        AND indexname = ANY($1)
        """,
        required_indexes
    )
    
    found_indexes = {row['indexname'] for row in existing_indexes}
    missing_indexes = set(required_indexes) - found_indexes
    
    if missing_indexes:
        logger.warning(f"⚠️  Missing indexes: {', '.join(missing_indexes)}")
        validation_passed = False
    else:
        logger.info(f"✅ All required indexes exist ({len(found_indexes)}/{len(required_indexes)})")
    
    # Test 2: Query performance test
    logger.info("\n🔍 Test 2: Testing query performance...")
    
    test_queries = [
        {
            "name": "Top Shorts Query",
            "sql": """
                EXPLAIN ANALYZE
                WITH max_date AS (
                    SELECT MAX("DATE") as latest_date FROM shorts
                ),
                latest_shorts AS (
                    SELECT "PRODUCT_CODE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
                    FROM shorts, max_date
                    WHERE "DATE" = max_date.latest_date
                      AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
                )
                SELECT "PRODUCT_CODE"
                FROM latest_shorts
                ORDER BY "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
                LIMIT 10
            """,
            "max_time": 1.0  # Should complete in < 1 second
        },
        {
            "name": "Stock Detail Query",
            "sql": """
                EXPLAIN ANALYZE
                SELECT "PRODUCT_CODE", "DATE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
                FROM shorts
                WHERE "PRODUCT_CODE" = 'CBA'
                  AND "DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '3 months'
                ORDER BY "DATE" DESC
            """,
            "max_time": 0.5  # Should complete in < 0.5 seconds
        }
    ]
    
    for test in test_queries:
        logger.info(f"\n  Testing: {test['name']}...")
        start_time = datetime.now()
        
        try:
            result = await conn.fetch(test['sql'])
            elapsed = (datetime.now() - start_time).total_seconds()
            
            # Check if index scans are used
            explain_text = "\n".join([row[0] for row in result])
            
            if "Index Scan" in explain_text or "Bitmap Index Scan" in explain_text:
                logger.info(f"  ✅ Query uses indexes (Index Scan detected)")
            elif "Seq Scan" in explain_text:
                logger.warning(f"  ⚠️  Query uses sequential scan (may need optimization)")
            
            if elapsed <= test['max_time']:
                logger.info(f"  ✅ Query completed in {elapsed:.3f}s (target: <{test['max_time']}s)")
            else:
                logger.warning(f"  ⚠️  Query took {elapsed:.3f}s (target: <{test['max_time']}s)")
                validation_passed = False
                
        except Exception as e:
            logger.error(f"  ❌ Query failed: {e}")
            validation_passed = False
    
    # Test 3: Check table sizes
    logger.info("\n🔍 Test 3: Checking table sizes...")
    
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
        logger.info(f"\n  {row['tablename']}:")
        logger.info(f"    Table: {row['table_size']}")
        logger.info(f"    Indexes: {row['indexes_size']}")
        logger.info(f"    Total: {row['total_size']}")
    
    return validation_passed


async def main():
    """Main optimization function."""
    database_url = os.getenv("SUPABASE_DB_URL") or os.getenv("DATABASE_URL")
    
    if not database_url:
        logger.error("❌ DATABASE_URL or SUPABASE_DB_URL environment variable is required")
        logger.error("Please set one of these environment variables with your database connection string")
        sys.exit(1)
    
    logger.info("🚀 Starting database optimization...")
    logger.info(f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    try:
        # Connect to database
        conn = await check_connection(database_url)
        
        # Step 1: Apply indexes
        indexes_success = await apply_indexes(conn)
        if not indexes_success:
            logger.error("❌ Failed to apply indexes")
            await conn.close()
            sys.exit(1)
        
        # Step 2: Update statistics
        stats_success = await update_statistics(conn)
        if not stats_success:
            logger.error("❌ Failed to update statistics")
            await conn.close()
            sys.exit(1)
        
        # Step 3: Validate optimizations
        validation_success = await validate_optimizations(conn)
        
        await conn.close()
        
        # Final summary
        logger.info("\n" + "=" * 80)
        logger.info("📋 OPTIMIZATION SUMMARY")
        logger.info("=" * 80)
        logger.info(f"✅ Indexes applied: {'Yes' if indexes_success else 'No'}")
        logger.info(f"✅ Statistics updated: {'Yes' if stats_success else 'No'}")
        logger.info(f"✅ Validation passed: {'Yes' if validation_success else 'No'}")
        
        if indexes_success and stats_success and validation_success:
            logger.info("\n🎉 Database optimization completed successfully!")
            logger.info("✅ All optimizations applied and validated")
            sys.exit(0)
        else:
            logger.warning("\n⚠️  Optimization completed with warnings")
            logger.warning("Please review the output above for details")
            sys.exit(1)
            
    except Exception as e:
        logger.error(f"❌ Fatal error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

