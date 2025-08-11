#!/usr/bin/env python3
"""
Fetch 10 years of real historical data for ASX stocks using yfinance
Improved version with better error handling and incremental updates
"""
import asyncio
import asyncpg
from datetime import datetime, date, timedelta
import yfinance as yf
import pandas as pd
from typing import Dict, List
import time

# Use Supabase database
DATABASE_URL = "postgres://postgres.vfzzkelbpyjdvuujyrpu:bxmsrFPazXawzeav@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"

# ASX stocks with their yfinance tickers
ASX_STOCKS = {
    'CBA': 'CBA.AX',    # Commonwealth Bank
    'BHP': 'BHP.AX',    # BHP Billiton  
    'CSL': 'CSL.AX',    # CSL Limited
    'WBC': 'WBC.AX',    # Westpac
    'ANZ': 'ANZ.AX',    # ANZ Bank
    'NAB': 'NAB.AX',    # National Australia Bank
    'WOW': 'WOW.AX',    # Woolworths Group
    'COL': 'COL.AX',    # Coles Group  
    'WES': 'WES.AX',    # Wesfarmers
    'RIO': 'RIO.AX',    # Rio Tinto
    'TLS': 'TLS.AX',    # Telstra
    'FMG': 'FMG.AX',    # Fortescue Metals Group
    'NCM': 'NCM.AX',    # Newcrest Mining
    'STO': 'STO.AX',    # Santos
}

def fetch_stock_data_sync(stock_code: str, yf_ticker: str, years: int = 10) -> List[Dict]:
    """Fetch historical data for a single stock using yfinance (synchronous)"""
    print(f"📈 Fetching {years} years of data for {stock_code} ({yf_ticker})...")
    
    try:
        # Create yfinance Ticker object
        ticker = yf.Ticker(yf_ticker)
        
        # Calculate date range
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
            # Skip rows with NaN values
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
                'adjusted_close': round(float(row['Close']), 2),  # yfinance data is already adjusted
                'volume': int(row['Volume']) if not pd.isna(row['Volume']) else 0
            })
        
        print(f"  ✅ Fetched {len(data)} records (from {data[0]['date'] if data else 'N/A'} to {data[-1]['date'] if data else 'N/A'})")
        return data
        
    except Exception as e:
        print(f"  ❌ Error fetching {stock_code}: {e}")
        return []

async def update_stock_in_database(conn, stock_code: str, yf_ticker: str, years: int = 10):
    """Update a single stock's data in the database"""
    
    # Check what data we already have
    existing_data = await conn.fetchrow("""
        SELECT COUNT(*) as count, MIN(date) as earliest, MAX(date) as latest 
        FROM stock_prices 
        WHERE stock_code = $1
    """, stock_code)
    
    if existing_data['count'] > 0:
        print(f"  📊 Existing data: {existing_data['count']} records from {existing_data['earliest']} to {existing_data['latest']}")
        
        # Skip if we already have recent data (less than a week old)
        if existing_data['latest'] and existing_data['latest'] >= date.today() - timedelta(days=7):
            print(f"  ⏭️  Skipping {stock_code} - data is up to date")
            return existing_data['count']
    
    # Fetch new data
    stock_data = fetch_stock_data_sync(stock_code, yf_ticker, years)
    
    if not stock_data:
        return 0
    
    # Insert/update data
    inserted = 0
    updated = 0
    
    for record in stock_data:
        try:
            result = await conn.fetchrow("""
                INSERT INTO stock_prices 
                (stock_code, date, open, high, low, close, adjusted_close, volume)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (stock_code, date) DO UPDATE SET
                    open = EXCLUDED.open,
                    high = EXCLUDED.high,
                    low = EXCLUDED.low,
                    close = EXCLUDED.close,
                    adjusted_close = EXCLUDED.adjusted_close,
                    volume = EXCLUDED.volume,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING (xmax = 0) AS inserted
            """, 
            record['stock_code'], record['date'], record['open'], 
            record['high'], record['low'], record['close'], 
            record['adjusted_close'], record['volume'])
            
            if result['inserted']:
                inserted += 1
            else:
                updated += 1
                
        except Exception as e:
            print(f"    ⚠️  Failed to insert/update record for {record['date']}: {e}")
            continue
    
    print(f"  ✅ {stock_code}: {inserted} new, {updated} updated, {len(stock_data)} total records processed")
    return inserted

async def update_all_stocks():
    """Update all stocks with historical data"""
    print(f"🚀 Fetching real ASX historical data using yfinance...")
    print(f"📊 Processing {len(ASX_STOCKS)} stocks...")
    
    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        total_new_records = 0
        successful_stocks = 0
        
        for i, (stock_code, yf_ticker) in enumerate(ASX_STOCKS.items(), 1):
            print(f"\n[{i}/{len(ASX_STOCKS)}] Processing {stock_code}...")
            
            new_records = await update_stock_in_database(conn, stock_code, yf_ticker, 10)
            
            if new_records >= 0:  # >= 0 means success (could be 0 if up to date)
                successful_stocks += 1
                total_new_records += new_records
            
            # Small delay to be nice to Yahoo Finance
            time.sleep(2)
        
        # Final verification
        final_stats = await conn.fetch("""
            SELECT stock_code, COUNT(*) as record_count, MIN(date) as earliest, MAX(date) as latest
            FROM stock_prices 
            GROUP BY stock_code 
            ORDER BY stock_code
        """)
        
        total_records = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")
        date_range = await conn.fetchrow("""
            SELECT MIN(date) as earliest, MAX(date) as latest 
            FROM stock_prices
        """)
        
        print(f"\n🎉 Update completed!")
        print(f"📊 Total records in database: {total_records:,}")
        print(f"📅 Overall date range: {date_range['earliest']} to {date_range['latest']}")
        print(f"✅ Successfully processed: {successful_stocks}/{len(ASX_STOCKS)} stocks")
        print(f"➕ New records added: {total_new_records:,}")
        
        print(f"\n📋 Current database summary:")
        print("Stock  | Records | Earliest   | Latest     | Years")
        print("-------+---------+------------+------------+------")
        for row in final_stats:
            if row['earliest'] and row['latest']:
                years = (row['latest'] - row['earliest']).days / 365.25
                print(f"{row['stock_code']:<6} | {row['record_count']:>7,} | {row['earliest']} | {row['latest']} | {years:>4.1f}")
            else:
                print(f"{row['stock_code']:<6} | {row['record_count']:>7,} | {'N/A':<10} | {'N/A':<10} | {'N/A':>4}")
        
    except Exception as e:
        print(f"❌ Error: {e}")
        raise
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(update_all_stocks())