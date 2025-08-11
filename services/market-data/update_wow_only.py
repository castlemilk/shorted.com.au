#!/usr/bin/env python3
"""
Update just WOW with 10 years of real data to test the pipeline
"""
import asyncio
import asyncpg
from datetime import date, timedelta
import yfinance as yf
import pandas as pd

DATABASE_URL = "postgres://postgres.vfzzkelbpyjdvuujyrpu:bxmsrFPazXawzeav@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"

async def update_wow_with_real_data():
    """Update WOW with 10 years of real historical data"""
    print("🧪 Testing WOW update with 10 years of real data...")
    
    # Fetch data from yfinance
    print("📈 Fetching WOW data from yfinance...")
    ticker = yf.Ticker("WOW.AX")
    end_date = date.today()
    start_date = end_date - timedelta(days=10 * 365)
    
    hist = ticker.history(start=start_date, end=end_date, interval='1d')
    
    if hist.empty:
        print("❌ No data fetched")
        return
    
    print(f"✅ Fetched {len(hist)} records from {hist.index[0].date()} to {hist.index[-1].date()}")
    
    # Convert to our format
    data = []
    for date_idx, row in hist.iterrows():
        if pd.isna(row['Open']) or pd.isna(row['Close']):
            continue
            
        data.append({
            'stock_code': 'WOW',
            'date': date_idx.date(),
            'open': round(float(row['Open']), 2),
            'high': round(float(row['High']), 2),
            'low': round(float(row['Low']), 2),
            'close': round(float(row['Close']), 2),
            'adjusted_close': round(float(row['Close']), 2),
            'volume': int(row['Volume']) if not pd.isna(row['Volume']) else 0
        })
    
    print(f"📊 Prepared {len(data)} records for database insertion")
    
    # Update database
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        # Check existing data
        existing = await conn.fetchval("SELECT COUNT(*) FROM stock_prices WHERE stock_code = 'WOW'")
        print(f"📋 Existing WOW records: {existing}")
        
        # Delete existing WOW data
        await conn.execute("DELETE FROM stock_prices WHERE stock_code = 'WOW'")
        print("🗑️  Deleted existing WOW data")
        
        # Insert new data
        inserted = 0
        for record in data:
            await conn.execute("""
                INSERT INTO stock_prices 
                (stock_code, date, open, high, low, close, adjusted_close, volume)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """, 
            record['stock_code'], record['date'], record['open'], 
            record['high'], record['low'], record['close'], 
            record['adjusted_close'], record['volume'])
            inserted += 1
        
        print(f"✅ Inserted {inserted} new WOW records")
        
        # Verify the data
        wow_stats = await conn.fetchrow("""
            SELECT COUNT(*) as count, MIN(date) as earliest, MAX(date) as latest,
                   MIN(close) as min_price, MAX(close) as max_price,
                   AVG(volume)::bigint as avg_volume
            FROM stock_prices WHERE stock_code = 'WOW'
        """)
        
        print(f"\n🎉 WOW Data Summary:")
        print(f"📊 Records: {wow_stats['count']:,}")
        print(f"📅 Date range: {wow_stats['earliest']} to {wow_stats['latest']}")
        print(f"💰 Price range: ${wow_stats['min_price']:.2f} - ${wow_stats['max_price']:.2f}")
        print(f"📈 Average volume: {wow_stats['avg_volume']:,}")
        
        years = (wow_stats['latest'] - wow_stats['earliest']).days / 365.25
        print(f"⏰ Years of data: {years:.1f}")
        
        # Show sample recent data
        sample = await conn.fetch("""
            SELECT date, open, high, low, close, volume
            FROM stock_prices 
            WHERE stock_code = 'WOW'
            ORDER BY date DESC 
            LIMIT 5
        """)
        
        print(f"\n📈 Recent WOW data:")
        print("Date       | Open   | High   | Low    | Close  | Volume  ")
        print("-----------+--------+--------+--------+--------+---------")
        for row in sample:
            print(f"{row['date']} | ${row['open']:<6.2f} | ${row['high']:<6.2f} | ${row['low']:<6.2f} | ${row['close']:<6.2f} | {row['volume']:>7,}")
        
    except Exception as e:
        print(f"❌ Database error: {e}")
        raise
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(update_wow_with_real_data())