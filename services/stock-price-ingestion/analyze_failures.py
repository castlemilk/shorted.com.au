#!/usr/bin/env python3
"""
Analyze why stocks are failing to fetch data
"""

import asyncio
import asyncpg
import yfinance as yf
import os
import sys
from collections import defaultdict

DATABASE_URL = os.getenv('DATABASE_URL')
if not DATABASE_URL:
    print("❌ ERROR: DATABASE_URL environment variable not set")
    sys.exit(1)

async def analyze_failures():
    """Analyze stock failures"""
    
    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        # Get all stock codes from shorts table
        all_stocks = await conn.fetch("""
            SELECT DISTINCT "PRODUCT_CODE" as code 
            FROM shorts 
            WHERE "PRODUCT_CODE" IS NOT NULL 
            AND LENGTH("PRODUCT_CODE") > 0
            ORDER BY "PRODUCT_CODE"
        """)
        
        # Get stocks that have price data
        stocks_with_data = await conn.fetch("""
            SELECT DISTINCT stock_code, COUNT(*) as count 
            FROM stock_prices 
            GROUP BY stock_code
        """)
        
        stocks_with_data_set = {row['stock_code'].replace('.AX', '') for row in stocks_with_data}
        
        print(f"📊 Analysis Results:")
        print(f"="*50)
        print(f"Total stocks in shorts table: {len(all_stocks)}")
        print(f"Stocks with price data: {len(stocks_with_data_set)}")
        print(f"Stocks without data: {len(all_stocks) - len(stocks_with_data_set)}")
        print(f"Success rate: {len(stocks_with_data_set)/len(all_stocks)*100:.1f}%")
        
        # Sample check - test a few missing stocks
        missing_stocks = []
        for row in all_stocks:
            code = row['code']
            if code not in stocks_with_data_set and f"{code}.AX" not in stocks_with_data_set:
                missing_stocks.append(code)
        
        print(f"\n🔍 Testing sample of missing stocks...")
        print(f"="*50)
        
        error_types = defaultdict(list)
        tested = 0
        
        for stock in missing_stocks[:20]:  # Test first 20
            tested += 1
            symbol = f"{stock}.AX"
            try:
                ticker = yf.Ticker(symbol)
                info = ticker.info
                
                if not info or 'symbol' not in info:
                    error_types['No info available'].append(stock)
                elif info.get('quoteType') == 'NONE':
                    error_types['Invalid symbol'].append(stock)
                else:
                    # Try to get history
                    hist = ticker.history(period="1d")
                    if hist.empty:
                        error_types['No trading history'].append(stock)
                    else:
                        error_types['Data exists but not fetched'].append(stock)
                        
            except Exception as e:
                error_msg = str(e)
                if 'delisted' in error_msg.lower():
                    error_types['Delisted'].append(stock)
                elif 'no timezone' in error_msg.lower():
                    error_types['No timezone (delisted)'].append(stock)
                elif '404' in error_msg:
                    error_types['Symbol not found'].append(stock)
                else:
                    error_types[f'Other error'].append(stock)
        
        print(f"\nError breakdown from {tested} samples:")
        for error_type, stocks in error_types.items():
            print(f"  {error_type}: {len(stocks)} stocks")
            if len(stocks) <= 5:
                print(f"    Examples: {', '.join(stocks)}")
        
        # Check if these are old/stale entries in shorts table
        print(f"\n📅 Checking age of shorts data for missing stocks...")
        sample_missing = missing_stocks[:10]
        for stock in sample_missing:
            result = await conn.fetchrow("""
                SELECT 
                    MIN("DATE") as first_date,
                    MAX("DATE") as last_date,
                    COUNT(*) as num_entries
                FROM shorts 
                WHERE "PRODUCT_CODE" = $1
            """, stock)
            
            if result:
                print(f"  {stock}: {result['first_date']} to {result['last_date']} ({result['num_entries']} entries)")
    
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(analyze_failures())