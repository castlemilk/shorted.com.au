#!/usr/bin/env python3
"""
Populate a small batch of ASX stocks to test
"""
import asyncio
import asyncpg
from datetime import date, timedelta
import yfinance as yf
import pandas as pd
import time

DATABASE_URL = "postgres://postgres.vfzzkelbpyjdvuujyrpu:bxmsrFPazXawzeav@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"

# Small batch for testing
TEST_BATCH = {
    'MQG': 'MQG.AX',    # Macquarie Group
    'QAN': 'QAN.AX',    # Qantas Airways  
    'REA': 'REA.AX',    # REA Group
    'ALL': 'ALL.AX',    # Aristocrat Leisure
    'JHX': 'JHX.AX',    # James Hardie
}

def fetch_real_data(stock_code: str, yf_ticker: str, years: int = 10):
    """Fetch real historical data from yfinance"""
    print(f"  📈 Fetching {years} years of {stock_code} data...")
    
    try:
        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=years * 365)
        
        hist = ticker.history(start=start_date, end=end_date, interval='1d')
        
        if hist.empty:
            print(f"    ⚠️  No data available")
            return []
        
        # Convert to our format
        data = []
        for date_idx, row in hist.iterrows():
            if pd.isna(row['Open']) or pd.isna(row['Close']):
                continue
                
            data.append({
                'stock_code': stock_code,
                'date': date_idx.date(),
                'open': round(float(row['Open']), 2),
                'high': round(float(row['High']), 2),
                'low': round(float(row['Low']), 2),
                'close': round(float(row['Close']), 2),
                'adjusted_close': round(float(row['Close']), 2),
                'volume': int(row['Volume']) if not pd.isna(row['Volume']) else 0
            })
        
        print(f"    ✅ {len(data)} records ({data[0]['date']} to {data[-1]['date']})")
        return data
        
    except Exception as e:
        print(f"    ❌ Error: {e}")
        return []

async def update_stock(conn, stock_code: str, yf_ticker: str):
    """Update a single stock with real historical data"""
    
    # Check existing data
    existing = await conn.fetchrow("""
        SELECT COUNT(*) as count FROM stock_prices WHERE stock_code = $1
    """, stock_code)
    
    if existing['count'] > 2000:
        print(f"  ⏭️  Skipping {stock_code} - already has {existing['count']:,} records")
        return 0
    
    # Fetch real data
    data = fetch_real_data(stock_code, yf_ticker, 10)
    
    if not data:
        return 0
    
    # Delete existing data for clean replacement
    await conn.execute("DELETE FROM stock_prices WHERE stock_code = $1", stock_code)
    
    # Insert new data
    inserted = 0
    for record in data:
        try:
            await conn.execute("""
                INSERT INTO stock_prices 
                (stock_code, date, open, high, low, close, adjusted_close, volume)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """, 
            record['stock_code'], record['date'], record['open'], 
            record['high'], record['low'], record['close'], 
            record['adjusted_close'], record['volume'])
            inserted += 1
        except Exception as e:
            # Skip duplicates
            pass
    
    print(f"    ✅ Inserted {inserted} records")
    return inserted

async def main():
    """Main function"""
    print(f"🚀 Populating {len(TEST_BATCH)} test stocks")
    
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        for stock_code, yf_ticker in TEST_BATCH.items():
            print(f"\n📊 Processing {stock_code}")
            await update_stock(conn, stock_code, yf_ticker)
            time.sleep(2)  # Rate limiting
        
        # Show results
        count = await conn.fetchval("SELECT COUNT(DISTINCT stock_code) FROM stock_prices")
        total = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")
        print(f"\n✅ Complete! Database now has {count} stocks with {total:,} total records")
        
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(main())