#!/usr/bin/env python3
"""
Apply search indexes migration to Supabase database.
This script handles connection issues and provides detailed error information.
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
    """Apply the search indexes migration to the database."""

    # Database connection parameters
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        logger.error("DATABASE_URL environment variable is not set")
        return

    logger.info("🔧 Applying search indexes migration to Supabase...")

    try:
        # Try to connect with various SSL modes
        ssl_modes = ["require", "prefer", "allow", "disable"]

        for ssl_mode in ssl_modes:
            try:
                logger.info(f"🔍 Trying connection with SSL mode: {ssl_mode}")
                conn = await asyncpg.connect(database_url, ssl=ssl_mode)
                logger.info(f"✅ Connected successfully with SSL mode: {ssl_mode}")
                break
            except Exception as e:
                logger.warning(f"❌ Failed with SSL mode {ssl_mode}: {e}")
                if ssl_mode == ssl_modes[-1]:  # Last attempt
                    raise e
        else:
            raise Exception("All SSL connection attempts failed")

        # Read migration file
        migration_file = "supabase/migrations/002_add_search_indexes.sql"
        logger.info(f"📝 Reading migration file: {migration_file}")

        with open(migration_file, "r") as f:
            migration_sql = f.read()

        # Apply migration
        logger.info("📝 Applying search indexes migration...")
        await conn.execute(migration_sql)

        # Verify indexes were created
        logger.info("🔍 Verifying indexes were created...")
        result = await conn.fetch(
            """
            SELECT indexname, indexdef 
            FROM pg_indexes 
            WHERE tablename = 'shorts' 
            AND indexname LIKE 'idx_shorts_%'
            ORDER BY indexname
        """
        )

        logger.info(f"✅ Created {len(result)} indexes:")
        for row in result:
            logger.info(f"  - {row['indexname']}")

        await conn.close()
        logger.info("🎉 Search indexes migration completed successfully!")
        return True

    except Exception as e:
        logger.error(f"❌ Failed to apply migration: {e}")
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
