#!/usr/bin/env python3
"""
Setup script to create stock_prices table and populate sample data
"""
import asyncio
import asyncpg
from datetime import datetime, date, timedelta
import random
import os

# Use Supabase database
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")

# ASX stock codes we want to populate
STOCK_CODES = ["CBA", "BHP", "CSL", "WBC", "ANZ", "NAB", "XRO", "APT", "WDS", "TLS"]

# Base prices for realistic data
BASE_PRICES = {
    "CBA": 97.50,  # Commonwealth Bank
    "BHP": 44.30,  # BHP Billiton
    "CSL": 285.00,  # CSL Limited
    "WBC": 24.10,  # Westpac
    "ANZ": 28.50,  # ANZ Bank
    "NAB": 38.20,  # National Australia Bank
    "XRO": 158.00,  # Xero Limited
    "APT": 65.00,  # Afterpay/Block
    "WDS": 28.50,  # Woodside Energy
    "TLS": 3.85,  # Telstra
}


async def create_stock_prices_table(conn):
    """Create the stock_prices table"""
    print("📋 Creating stock_prices table...")

    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS stock_prices (
            id SERIAL PRIMARY KEY,
            stock_code VARCHAR(10) NOT NULL,
            date DATE NOT NULL,
            open DECIMAL(10, 2),
            high DECIMAL(10, 2),
            low DECIMAL(10, 2),
            close DECIMAL(10, 2),
            adjusted_close DECIMAL(10, 2),
            volume BIGINT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(stock_code, date)
        )
    """
    )

    # Create indexes
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_stock_prices_stock_code ON stock_prices(stock_code)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_stock_prices_date ON stock_prices(date DESC)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_stock_prices_stock_date ON stock_prices(stock_code, date DESC)"
    )

    print("  ✅ Table and indexes created successfully")


async def generate_stock_data(stock_code: str, base_price: float, num_days: int = 30):
    """Generate realistic stock price data for the last 30 days"""
    data = []
    current_price = base_price

    start_date = date.today() - timedelta(days=num_days)

    for i in range(num_days):
        current_date = start_date + timedelta(days=i)

        # Skip weekends
        if current_date.weekday() >= 5:
            continue

        # Random daily change between -3% and +3%
        change_percent = random.uniform(-0.03, 0.03)
        daily_change = current_price * change_percent

        # Calculate OHLC with some intraday variation
        open_price = current_price
        close_price = current_price + daily_change

        # High and low with some variation
        high_price = max(open_price, close_price) + abs(daily_change) * random.uniform(
            0, 0.8
        )
        low_price = min(open_price, close_price) - abs(daily_change) * random.uniform(
            0, 0.8
        )

        # Volume between 500k and 10M shares
        volume = random.randint(500000, 10000000)

        data.append(
            {
                "stock_code": stock_code,
                "date": current_date,
                "open": round(max(open_price, 0.01), 2),
                "high": round(max(high_price, 0.01), 2),
                "low": round(max(low_price, 0.01), 2),
                "close": round(max(close_price, 0.01), 2),
                "adjusted_close": round(max(close_price, 0.01), 2),
                "volume": volume,
            }
        )

        current_price = close_price

    return data


async def populate_database():
    """Setup database and populate with sample data"""
    print("🚀 Setting up database and populating stock data...")

    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)

    try:
        # Create table first
        await create_stock_prices_table(conn)

        total_records = 0

        for stock_code in STOCK_CODES:
            print(f"📈 Generating data for {stock_code}...")

            base_price = BASE_PRICES[stock_code]
            stock_data = await generate_stock_data(stock_code, base_price)

            # Insert data in batches
            for record in stock_data:
                await conn.execute(
                    """
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
                    record["stock_code"],
                    record["date"],
                    record["open"],
                    record["high"],
                    record["low"],
                    record["close"],
                    record["adjusted_close"],
                    record["volume"],
                )

            total_records += len(stock_data)
            print(f"  ✅ Inserted {len(stock_data)} records for {stock_code}")

        # Verify data
        count = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")
        print(f"\n🎉 Successfully populated {total_records} records!")
        print(f"📊 Total records in database: {count}")

        # Show sample data
        sample = await conn.fetch(
            """
            SELECT stock_code, date, close, volume 
            FROM stock_prices 
            ORDER BY date DESC, stock_code 
            LIMIT 12
        """
        )

        print("\n📋 Sample data:")
        print("Stock  | Date       | Close   | Volume")
        print("-------+------------+---------+---------")
        for row in sample:
            print(
                f"{row['stock_code']:<6} | {row['date']} | ${row['close']:<7} | {row['volume']:>7,}"
            )

    except Exception as e:
        print(f"❌ Error: {e}")
        raise
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(populate_database())
