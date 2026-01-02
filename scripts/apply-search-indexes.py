#!/usr/bin/env python3
"""
Apply database migration for search indexes.
This script applies the search optimization indexes to the Supabase database.
"""

import os
import asyncpg
import asyncio
import logging
from dotenv import load_dotenv

# Load environment variables from .env file (if it exists)
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def apply_migration():
    """Apply the search indexes migration to the database."""

    # Get database URL from environment
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        logger.error("DATABASE_URL environment variable is required")
        logger.error(
            "Please set DATABASE_URL environment variable or create a .env file with:"
        )
        logger.error("DATABASE_URL=postgresql://username:password@host:port/database")
        return False

    try:
        # Connect to database
        logger.info("Connecting to database...")
        conn = await asyncpg.connect(database_url)

        # Read migration file
        migration_file = "supabase/migrations/002_add_search_indexes.sql"
        logger.info(f"Reading migration file: {migration_file}")

        with open(migration_file, "r") as f:
            migration_sql = f.read()

        # Apply migration
        logger.info("Applying search indexes migration...")
        await conn.execute(migration_sql)

        # Verify indexes were created
        logger.info("Verifying indexes were created...")
        result = await conn.fetch(
            """
            SELECT indexname, indexdef 
            FROM pg_indexes 
            WHERE tablename = 'shorts' 
            AND indexname LIKE 'idx_shorts_%'
            ORDER BY indexname
        """
        )

        logger.info(f"Created {len(result)} indexes:")
        for row in result:
            logger.info(f"  - {row['indexname']}")

        await conn.close()
        logger.info("Migration applied successfully!")
        return True

    except Exception as e:
        logger.error(f"Failed to apply migration: {e}")
        return False


async def main():
    """Main function."""
    success = await apply_migration()
    if success:
        logger.info("✅ Search indexes migration completed successfully!")
    else:
        logger.error("❌ Search indexes migration failed!")
        exit(1)


if __name__ == "__main__":
    asyncio.run(main())
