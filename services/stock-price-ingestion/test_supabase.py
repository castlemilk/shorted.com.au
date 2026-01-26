#!/usr/bin/env python3
"""Simple test script to verify Supabase connection and data insertion"""

import asyncio
import asyncpg
from datetime import datetime, date
import yfinance as yf
import os
import sys

# Get database URL from environment variable
DATABASE_URL = os.getenv('DATABASE_URL')
if not DATABASE_URL:
    print("❌ ERROR: DATABASE_URL environment variable not set")
    print("Please set it using: export DATABASE_URL='your-database-url'")
    sys.exit(1)

async def test_connection():
    """Test basic database connection"""
    try:
        conn = await asyncpg.connect(DATABASE_URL)
        version = await conn.fetchval('SELECT version()')
        print(f"✅ Connected to database")
        print(f"   Version: {version[:50]}...")
        
        # Check tables
        tables = await conn.fetch("""
            SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' 
            AND tablename LIKE 'stock%'
            ORDER BY tablename
        """)
        print(f"\n📊 Stock tables found:")
        for table in tables:
            count = await conn.fetchval(f"SELECT COUNT(*) FROM {table['tablename']}")
            print(f"   - {table['tablename']}: {count} rows")
        
        await conn.close()
        return True
    except Exception as e:
        print(f"❌ Connection failed: {e}")
        return False

async def insert_test_data():
    """Insert some test stock data"""
    try:
        # Fetch real data from Yahoo Finance
        print("\n📈 Fetching CBA stock data...")
        ticker = yf.Ticker("CBA.AX")
        df = ticker.history(period="5d")
        
        if df.empty:
            print("❌ No data returned from Yahoo Finance")
            return False
        
        print(f"   Got {len(df)} days of data")
        
        # Connect and insert
        conn = await asyncpg.connect(DATABASE_URL)
        
        inserted = 0
        for idx, row in df.iterrows():
            try:
                await conn.execute("""
                    INSERT INTO stock_prices 
                    (stock_code, date, open, high, low, close, volume)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (stock_code, date) DO UPDATE SET
                        open = EXCLUDED.open,
                        high = EXCLUDED.high,
                        low = EXCLUDED.low,
                        close = EXCLUDED.close,
                        volume = EXCLUDED.volume,
                        updated_at = CURRENT_TIMESTAMP
                """, 
                "CBA.AX",
                idx.date(),
                float(row['Open']),
                float(row['High']),
                float(row['Low']),
                float(row['Close']),
                int(row['Volume'])
                )
                inserted += 1
                print(f"   ✅ Inserted {idx.date()}: Close=${row['Close']:.2f}")
            except Exception as e:
                print(f"   ❌ Error inserting {idx.date()}: {e}")
        
        # Verify insertion
        count = await conn.fetchval("SELECT COUNT(*) FROM stock_prices WHERE stock_code = 'CBA.AX'")
        print(f"\n✅ Successfully inserted {inserted} records")
        print(f"   Total CBA.AX records in database: {count}")
        
        # Show latest data
        latest = await conn.fetch("""
            SELECT date, close, volume 
            FROM stock_prices 
            WHERE stock_code = 'CBA.AX'
            ORDER BY date DESC 
            LIMIT 3
        """)
        print(f"\n📊 Latest CBA.AX prices:")
        for row in latest:
            print(f"   {row['date']}: ${row['close']:.2f} (volume: {row['volume']:,})")
        
        await conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Failed to insert data: {e}")
        import traceback
        traceback.print_exc()
        return False

async def main():
    print("🧪 Testing Supabase connection and data insertion\n")
    
    # Test connection
    if not await test_connection():
        return
    
    # Insert test data
    await insert_test_data()

if __name__ == "__main__":
    asyncio.run(main())