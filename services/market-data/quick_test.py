#!/usr/bin/env python3
"""
Quick test with just 3 stocks to verify the approach
"""
import asyncio
import asyncpg
from datetime import datetime, date, timedelta
import yfinance as yf
import pandas as pd
from typing import Dict, List
import time

DATABASE_URL = "postgres://postgres.vfzzkelbpyjdvuujyrpu:bxmsrFPazXawzeav@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"

# Test with just 3 popular ASX stocks
TEST_STOCKS = {
    'WOW': 'WOW.AX',    # Woolworths
    'CBA': 'CBA.AX',    # Commonwealth Bank
    'BHP': 'BHP.AX',    # BHP
}

def fetch_stock_data_sync(stock_code: str, yf_ticker: str, years: int = 10) -> List[Dict]:
    """Fetch historical data for a single stock using yfinance (synchronous)"""
    print(f"📈 Fetching {years} years of data for {stock_code} ({yf_ticker})...")
    
    try:
        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=years * 365)
        
        print(f"  📅 Date range: {start_date} to {end_date}")
        
        # Fetch historical data
        hist = ticker.history(start=start_date, end=end_date, interval='1d')
        
        if hist.empty:
            print(f"  ⚠️  No data available for {stock_code}")
            return []
        
        # Convert to list of dictionaries
        data = []
        for date_idx, row in hist.iterrows():
            if pd.isna(row['Open']) or pd.isna(row['Close']):
                continue
                
            trading_date = date_idx.date()
            
            data.append({
                'stock_code': stock_code,
                'date': trading_date,
                'open': round(float(row['Open']), 2),
                'high': round(float(row['High']), 2),
                'low': round(float(row['Low']), 2),
                'close': round(float(row['Close']), 2),
                'adjusted_close': round(float(row['Close']), 2),
                'volume': int(row['Volume']) if not pd.isna(row['Volume']) else 0
            })
        
        print(f"  ✅ Fetched {len(data)} records (from {data[0]['date'] if data else 'N/A'} to {data[-1]['date'] if data else 'N/A'})")
        return data
        
    except Exception as e:
        print(f"  ❌ Error fetching {stock_code}: {e}")
        return []

async def replace_stock_data(conn, stock_code: str, yf_ticker: str):
    """Replace a stock's data completely"""
    
    # Delete existing data for this stock
    deleted = await conn.fetchval("SELECT COUNT(*) FROM stock_prices WHERE stock_code = $1", stock_code)
    await conn.execute("DELETE FROM stock_prices WHERE stock_code = $1", stock_code)
    print(f"  🗑️  Deleted {deleted or 0} existing records for {stock_code}")
    
    # Fetch new data
    stock_data = fetch_stock_data_sync(stock_code, yf_ticker, 10)
    
    if not stock_data:
        return 0
    
    # Insert all new data
    inserted = 0
    
    for record in stock_data:
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
            print(f"    ⚠️  Failed to insert record for {record['date']}: {e}")
            continue
    
    print(f"  ✅ {stock_code}: Inserted {inserted}/{len(stock_data)} records")
    return inserted

async def quick_test():
    """Quick test with 3 stocks"""
    print(f"🧪 Quick test with {len(TEST_STOCKS)} stocks...")
    
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        for stock_code, yf_ticker in TEST_STOCKS.items():
            print(f"\nProcessing {stock_code}...")
            await replace_stock_data(conn, stock_code, yf_ticker)
            time.sleep(2)  # Be nice to Yahoo Finance
        
        # Show results
        results = await conn.fetch("""
            SELECT stock_code, COUNT(*) as records, MIN(date) as earliest, MAX(date) as latest
            FROM stock_prices 
            WHERE stock_code = ANY($1)
            GROUP BY stock_code 
            ORDER BY stock_code
        """, list(TEST_STOCKS.keys()))
        
        print(f"\n🎉 Test completed!")
        print("Stock | Records | Earliest   | Latest     | Years")
        print("------+---------+------------+------------+------")
        for row in results:
            years = (row['latest'] - row['earliest']).days / 365.25
            print(f"{row['stock_code']:<5} | {row['records']:>7,} | {row['earliest']} | {row['latest']} | {years:>4.1f}")
        
    except Exception as e:
        print(f"❌ Error: {e}")
        raise
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(quick_test())