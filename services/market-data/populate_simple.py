#!/usr/bin/env python3
"""
Simple script to populate ASX stocks one by one
"""
import asyncio
import asyncpg
from datetime import datetime, timedelta
import yfinance as yf
import sys

DATABASE_URL = "postgres://postgres.vfzzkelbpyjdvuujyrpu:bxmsrFPazXawzeav@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"

# Key ASX stocks to populate
STOCKS = [
    ('MQG', 'MQG.AX', 'Macquarie Group'),
    ('QAN', 'QAN.AX', 'Qantas Airways'),
    ('REA', 'REA.AX', 'REA Group'),
    ('ALL', 'ALL.AX', 'Aristocrat Leisure'),
    ('TCL', 'TCL.AX', 'Transurban'),
    ('GMG', 'GMG.AX', 'Goodman Group'),
    ('JHX', 'JHX.AX', 'James Hardie'),
    ('BXB', 'BXB.AX', 'Brambles'),
    ('AMC', 'AMC.AX', 'Amcor'),
    ('SGP', 'SGP.AX', 'Stockland'),
]

async def populate_stock(conn, stock_code, yf_ticker, name):
    """Populate a single stock"""
    try:
        # Check if already populated
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM stock_prices WHERE stock_code = $1",
            stock_code
        )
        
        if count > 1000:
            print(f"  ⏭️  {stock_code} already has {count} records")
            return
        
        # Fetch from yfinance
        print(f"  📈 Fetching {stock_code} ({name})...")
        ticker = yf.Ticker(yf_ticker)
        
        # Get 10 years of data
        end_date = datetime.now()
        start_date = end_date - timedelta(days=3650)  # ~10 years
        
        hist = ticker.history(start=start_date, end=end_date)
        
        if hist.empty:
            print(f"  ⚠️  No data for {stock_code}")
            return
        
        # Clear existing data
        await conn.execute(
            "DELETE FROM stock_prices WHERE stock_code = $1",
            stock_code
        )
        
        # Insert new data
        records = []
        for date, row in hist.iterrows():
            records.append((
                stock_code,
                date.date(),
                float(row['Open']),
                float(row['High']),
                float(row['Low']),
                float(row['Close']),
                float(row['Close']),  # adjusted_close
                int(row['Volume'])
            ))
        
        # Batch insert
        await conn.executemany("""
            INSERT INTO stock_prices 
            (stock_code, date, open, high, low, close, adjusted_close, volume)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        """, records)
        
        print(f"  ✅ Inserted {len(records)} records for {stock_code}")
        
    except Exception as e:
        print(f"  ❌ Error with {stock_code}: {e}")

async def main():
    """Main function"""
    print("🚀 Starting ASX stock data population\n")
    
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        # Initial count
        initial_count = await conn.fetchval(
            "SELECT COUNT(DISTINCT stock_code) FROM stock_prices"
        )
        print(f"📊 Starting with {initial_count} stocks in database\n")
        
        # Process each stock
        for i, (code, ticker, name) in enumerate(STOCKS, 1):
            print(f"[{i}/{len(STOCKS)}] Processing {code}")
            await populate_stock(conn, code, ticker, name)
            print()
        
        # Final statistics
        final_count = await conn.fetchval(
            "SELECT COUNT(DISTINCT stock_code) FROM stock_prices"
        )
        total_records = await conn.fetchval(
            "SELECT COUNT(*) FROM stock_prices"
        )
        
        print(f"\n✅ Complete!")
        print(f"📊 Now have {final_count} stocks ({final_count - initial_count} added)")
        print(f"📈 Total records: {total_records:,}")
        
    except Exception as e:
        print(f"❌ Fatal error: {e}")
        sys.exit(1)
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(main())