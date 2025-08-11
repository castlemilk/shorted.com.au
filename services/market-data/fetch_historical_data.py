#!/usr/bin/env python3
"""
Fetch 10 years of real historical data for ASX stocks using yfinance
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

# All ASX stocks we want to fetch (add .AX suffix for yfinance)
ASX_STOCKS = {
    'CBA': 'CBA.AX',    # Commonwealth Bank
    'BHP': 'BHP.AX',    # BHP Billiton  
    'CSL': 'CSL.AX',    # CSL Limited
    'WBC': 'WBC.AX',    # Westpac
    'ANZ': 'ANZ.AX',    # ANZ Bank
    'NAB': 'NAB.AX',    # National Australia Bank
    'XRO': 'XRO.AX',    # Xero Limited
    'APT': 'SQ2.AX',    # Block (formerly Afterpay) - ticker changed
    'WDS': 'WDS.AX',    # Woodside Energy
    'TLS': 'TLS.AX',    # Telstra
    'WOW': 'WOW.AX',    # Woolworths Group
    'COL': 'COL.AX',    # Coles Group  
    'WES': 'WES.AX',    # Wesfarmers
    'RIO': 'RIO.AX',    # Rio Tinto
    'FMG': 'FMG.AX',    # Fortescue Metals Group
    'NCM': 'NCM.AX',    # Newcrest Mining
    'STO': 'STO.AX',    # Santos
    'ORG': 'ORG.AX',    # Origin Energy
    'OSH': 'OSH.AX',    # Oil Search
    'WTC': 'WTC.AX',    # WiseTech Global
    'CPU': 'CPU.AX',    # Computershare
    'COH': 'COH.AX',    # Cochlear
    'SHL': 'SHL.AX',    # Sonic Healthcare
    'RMD': 'RMD.AX',    # ResMed
    'TWE': 'TWE.AX'     # Treasury Wine Estates
}

async def fetch_stock_data(stock_code: str, yf_ticker: str, years: int = 10) -> List[Dict]:
    """Fetch historical data for a single stock using yfinance"""
    print(f"📈 Fetching {years} years of data for {stock_code} ({yf_ticker})...")
    
    try:
        # Create yfinance Ticker object
        ticker = yf.Ticker(yf_ticker)
        
        # Calculate date range (10 years back from today)
        end_date = date.today()
        start_date = end_date - timedelta(days=years * 365)
        
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
                'adjusted_close': round(float(row['Close']), 2),  # yfinance already adjusts
                'volume': int(row['Volume']) if not pd.isna(row['Volume']) else 0
            })
        
        print(f"  ✅ Fetched {len(data)} records for {stock_code} (from {data[0]['date'] if data else 'N/A'} to {data[-1]['date'] if data else 'N/A'})")
        return data
        
    except Exception as e:
        print(f"  ❌ Error fetching {stock_code}: {e}")
        return []

async def update_database_with_historical_data(years: int = 10):
    """Fetch and update database with real historical data"""
    print(f"🚀 Fetching {years} years of real ASX historical data using yfinance...")
    
    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        # Clear existing data first (optional - comment out to keep existing data)
        print("🗑️  Clearing existing data...")
        await conn.execute("DELETE FROM stock_prices")
        
        total_records = 0
        successful_stocks = 0
        
        for stock_code, yf_ticker in ASX_STOCKS.items():
            print(f"\n📊 Processing {stock_code}...")
            
            # Fetch data from yfinance
            stock_data = await fetch_stock_data(stock_code, yf_ticker, years)
            
            if not stock_data:
                continue
                
            # Insert data into database in batches
            batch_size = 100
            inserted = 0
            
            for i in range(0, len(stock_data), batch_size):
                batch = stock_data[i:i + batch_size]
                
                for record in batch:
                    try:
                        await conn.execute("""
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
                        """, 
                        record['stock_code'], record['date'], record['open'], 
                        record['high'], record['low'], record['close'], 
                        record['adjusted_close'], record['volume'])
                        inserted += 1
                    except Exception as e:
                        print(f"    ⚠️  Failed to insert record for {record['date']}: {e}")
                        continue
            
            total_records += inserted
            successful_stocks += 1
            print(f"  ✅ Inserted {inserted}/{len(stock_data)} records for {stock_code}")
            
            # Small delay to be nice to Yahoo Finance
            time.sleep(1)
        
        # Verify final data
        final_count = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")
        date_range = await conn.fetchrow("""
            SELECT MIN(date) as earliest, MAX(date) as latest 
            FROM stock_prices
        """)
        
        stocks_with_data = await conn.fetch("""
            SELECT stock_code, COUNT(*) as record_count, MIN(date) as earliest, MAX(date) as latest
            FROM stock_prices 
            GROUP BY stock_code 
            ORDER BY stock_code
        """)
        
        print(f"\n🎉 Successfully updated database with real historical data!")
        print(f"📊 Total records: {final_count:,}")
        print(f"📅 Date range: {date_range['earliest']} to {date_range['latest']}")
        print(f"📈 Successful stocks: {successful_stocks}/{len(ASX_STOCKS)}")
        
        print(f"\n📋 Stock data summary:")
        print("Stock  | Records | Earliest   | Latest     ")
        print("-------+---------+------------+------------")
        for row in stocks_with_data:
            print(f"{row['stock_code']:<6} | {row['record_count']:>7,} | {row['earliest']} | {row['latest']}")
        
        # Show sample recent data
        sample = await conn.fetch("""
            SELECT stock_code, date, close, volume 
            FROM stock_prices 
            WHERE date >= CURRENT_DATE - INTERVAL '7 days'
            ORDER BY date DESC, stock_code 
            LIMIT 15
        """)
        
        if sample:
            print(f"\n🔍 Recent data sample:")
            print("Stock  | Date       | Close   | Volume  ")
            print("-------+------------+---------+---------")
            for row in sample:
                print(f"{row['stock_code']:<6} | {row['date']} | ${row['close']:<7} | {row['volume']:>7,}")
        
    except Exception as e:
        print(f"❌ Error: {e}")
        raise
    finally:
        await conn.close()

if __name__ == "__main__":
    print("Installing required packages...")
    import subprocess
    import sys
    
    # Install yfinance if not available
    try:
        import yfinance
    except ImportError:
        print("Installing yfinance...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "yfinance"])
        import yfinance as yf
    
    # Install pandas if not available  
    try:
        import pandas
    except ImportError:
        print("Installing pandas...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pandas"])
        import pandas as pd
    
    asyncio.run(update_database_with_historical_data(10))