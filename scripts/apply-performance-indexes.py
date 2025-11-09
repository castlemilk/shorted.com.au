#!/usr/bin/env python3
"""
Apply performance indexes migration to database.
This script applies critical indexes for treemap and top shorts query optimization.
"""

import os
import sys
import asyncio
import asyncpg
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


async def apply_migration():
    """Apply the performance indexes migration to the database."""

    # Try to get database URL from environment
    database_url = os.getenv("SUPABASE_DB_URL") or os.getenv("DATABASE_URL")
    
    if not database_url:
        logger.error("❌ DATABASE_URL or SUPABASE_DB_URL environment variable is required")
        logger.error("Please set one of these environment variables with your database connection string")
        return False

    logger.info("🔧 Applying performance indexes migration...")

    try:
        # Connect to database
        logger.info("🔌 Connecting to database...")
        # Disable statement cache for pgbouncer compatibility
        conn = await asyncpg.connect(database_url, statement_cache_size=0)
        logger.info("✅ Connected successfully")

        # Read migration file
        migration_file = "supabase/migrations/003_add_performance_indexes.sql"
        logger.info(f"📝 Reading migration file: {migration_file}")

        with open(migration_file, "r") as f:
            migration_sql = f.read()

        # Apply migration
        logger.info("⚡ Creating performance indexes...")
        await conn.execute(migration_sql)

        # Verify indexes were created
        logger.info("🔍 Verifying indexes...")
        
        # Check shorts table indexes
        shorts_result = await conn.fetch(
            """
            SELECT 
                indexname, 
                indexdef,
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

        logger.info(f"✅ Created {len(shorts_result)} indexes on shorts table:")
        for row in shorts_result:
            logger.info(f"  - {row['indexname']} ({row['size']})")

        # Check company-metadata table indexes
        metadata_result = await conn.fetch(
            """
            SELECT 
                indexname, 
                indexdef,
                pg_size_pretty(pg_relation_size(indexname::regclass)) as size
            FROM pg_indexes 
            WHERE tablename = 'company-metadata' 
            AND indexname LIKE 'idx_company_metadata%'
            ORDER BY indexname
        """
        )

        logger.info(f"✅ Created {len(metadata_result)} indexes on company-metadata table:")
        for row in metadata_result:
            logger.info(f"  - {row['indexname']} ({row['size']})")

        # Show table statistics
        logger.info("\n📊 Table statistics:")
        stats = await conn.fetch(
            """
            SELECT 
                schemaname,
                tablename,
                pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size,
                pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size,
                pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - 
                              pg_relation_size(schemaname||'.'||tablename)) as indexes_size
            FROM pg_tables
            WHERE tablename IN ('shorts', 'company-metadata')
            AND schemaname = 'public'
        """
        )

        for row in stats:
            logger.info(f"  {row['tablename']}: {row['table_size']} (table) + {row['indexes_size']} (indexes) = {row['total_size']} (total)")

        await conn.close()
        logger.info("\n🎉 Performance indexes migration completed successfully!")
        return True

    except Exception as e:
        logger.error(f"❌ Failed to apply migration: {e}")
        import traceback
        traceback.print_exc()
        return False


async def main():
    """Main function."""
    success = await apply_migration()
    if success:
        logger.info("✅ Migration completed successfully!")
        sys.exit(0)
    else:
        logger.error("❌ Migration failed!")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

