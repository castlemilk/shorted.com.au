"""
Test database connection for Cloud Run service.
"""

import asyncio
import asyncpg
import os

async def test_database_connection():
    """Test database connection."""
    DATABASE_URL = "postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"
    
    try:
        print("Testing database connection...")
        conn = await asyncpg.connect(DATABASE_URL)
        print("✅ Database connection successful")
        
        # Test a simple query
        result = await conn.fetchval("SELECT COUNT(*) FROM stocks")
        print(f"✅ Query successful: {result} stocks in database")
        
        await conn.close()
        print("✅ Database connection closed")
        
        # Test connection pool
        print("Testing connection pool...")
        pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
        print("✅ Connection pool created")
        
        async with pool.acquire() as conn:
            result = await conn.fetchval("SELECT COUNT(*) FROM stocks")
            print(f"✅ Pool query successful: {result} stocks in database")
        
        await pool.close()
        print("✅ Connection pool closed")
        
        print("🎉 All database tests passed!")
        
    except Exception as e:
        print(f"❌ Database error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test_database_connection())

