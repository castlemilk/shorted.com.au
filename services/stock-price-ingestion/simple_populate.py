#!/usr/bin/env python3
"""
Simple script to populate stock data for testing
"""
import asyncio
import asyncpg
from datetime import datetime, date, timedelta
import random

# Database configuration
DATABASE_URL = "postgresql://admin:password@localhost:5438/shorts"

# ASX stock codes we want to populate (same as in portfolio)
STOCK_CODES = ['CBA', 'BHP', 'CSL', 'WBC', 'ANZ', 'NAB']

# Base prices for realistic data (approximate real values)
BASE_PRICES = {
    'CBA': 97.50,  # Commonwealth Bank
    'BHP': 44.30,  # BHP Billiton
    'CSL': 285.00, # CSL Limited
    'WBC': 24.10,  # Westpac
    'ANZ': 28.50,  # ANZ Bank
    'NAB': 38.20   # National Australia Bank
}

async def generate_stock_data(stock_code: str, base_price: float, num_days: int = 90):
    """Generate realistic stock price data"""
    data = []
    current_price = base_price
    
    start_date = date.today() - timedelta(days=num_days)
    
    for i in range(num_days):
        current_date = start_date + timedelta(days=i)
        
        # Skip weekends
        if current_date.weekday() >= 5:
            continue
            
        # Random daily change between -5% and +5%
        change_percent = random.uniform(-0.05, 0.05)
        daily_change = current_price * change_percent
        
        # Calculate OHLC with some intraday variation
        open_price = current_price
        close_price = current_price + daily_change
        
        # High and low with some variation
        high_price = max(open_price, close_price) + abs(daily_change) * random.uniform(0, 0.5)
        low_price = min(open_price, close_price) - abs(daily_change) * random.uniform(0, 0.5)
        
        # Volume between 100k and 5M shares
        volume = random.randint(100000, 5000000)
        
        data.append({
            'stock_code': stock_code,
            'date': current_date,
            'open': round(open_price, 2),
            'high': round(high_price, 2),
            'low': round(low_price, 2),
            'close': round(close_price, 2),
            'adjusted_close': round(close_price, 2),
            'volume': volume
        })
        
        current_price = close_price
    
    return data

async def populate_database():
    """Populate the database with stock data"""
    print("🚀 Starting stock data population...")
    
    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        total_records = 0
        
        for stock_code in STOCK_CODES:
            print(f"📈 Generating data for {stock_code}...")
            
            base_price = BASE_PRICES[stock_code]
            stock_data = await generate_stock_data(stock_code, base_price)
            
            # Insert data in batches
            for record in stock_data:
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
            
            total_records += len(stock_data)
            print(f"  ✅ Inserted {len(stock_data)} records for {stock_code}")
        
        # Verify data
        count = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")
        print(f"\n🎉 Successfully populated {total_records} records!")
        print(f"📊 Total records in database: {count}")
        
        # Show sample data
        sample = await conn.fetch("""
            SELECT stock_code, date, close, volume 
            FROM stock_prices 
            ORDER BY date DESC, stock_code 
            LIMIT 10
        """)
        
        print("\n📋 Sample data:")
        print("Stock  | Date       | Close   | Volume")
        print("-------+------------+---------+---------")
        for row in sample:
            print(f"{row['stock_code']:<6} | {row['date']} | ${row['close']:<7} | {row['volume']:>7,}")
            
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(populate_database())