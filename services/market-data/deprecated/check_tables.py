"""
Check what tables exist in the database.
"""

import asyncio
import asyncpg
import os

async def check_database_tables():
    """Check what tables exist in the database."""
    DATABASE_URL = "postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"
    
    try:
        print("Checking database tables...")
        conn = await asyncpg.connect(DATABASE_URL)
        
        # Get all tables
        tables = await conn.fetch("""
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
        """)
        
        print(f"📊 Found {len(tables)} tables:")
        for table in tables:
            print(f"   - {table['table_name']}")
        
        # Check if stocks table exists
        stocks_exists = await conn.fetchval("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'stocks'
            )
        """)
        
        if stocks_exists:
            print("✅ stocks table exists")
            count = await conn.fetchval("SELECT COUNT(*) FROM stocks")
            print(f"📈 stocks table has {count} records")
        else:
            print("❌ stocks table does not exist")
        
        await conn.close()
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(check_database_tables())

