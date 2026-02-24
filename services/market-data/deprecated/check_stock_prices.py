"""
Check stock_prices table structure and content.
"""

import asyncio
import asyncpg
import os

async def check_stock_prices_table():
    """Check stock_prices table structure and content."""
    DATABASE_URL = os.environ["DATABASE_URL"]
    
    try:
        print("Checking stock_prices table...")
        conn = await asyncpg.connect(DATABASE_URL)
        
        # Get table structure
        columns = await conn.fetch("""
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'stock_prices'
            ORDER BY ordinal_position
        """)
        
        print("📊 stock_prices table structure:")
        for col in columns:
            print(f"   - {col['column_name']}: {col['data_type']} ({'NULL' if col['is_nullable'] == 'YES' else 'NOT NULL'})")
        
        # Get sample data
        sample = await conn.fetch("SELECT * FROM stock_prices LIMIT 5")
        print(f"\n📈 Sample data ({len(sample)} records):")
        for row in sample:
            print(f"   - {row}")
        
        # Get unique stock codes
        stock_codes = await conn.fetch("SELECT DISTINCT stock_code FROM stock_prices ORDER BY stock_code LIMIT 10")
        print(f"\n🏷️ Sample stock codes ({len(stock_codes)} shown):")
        for code in stock_codes:
            print(f"   - {code['stock_code']}")
        
        # Get total count
        total_count = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")
        unique_stocks = await conn.fetchval("SELECT COUNT(DISTINCT stock_code) FROM stock_prices")
        print(f"\n📊 Total records: {total_count:,}")
        print(f"📊 Unique stocks: {unique_stocks:,}")
        
        await conn.close()
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(check_stock_prices_table())

