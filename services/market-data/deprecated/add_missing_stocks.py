#!/usr/bin/env python3
"""
Add missing major ASX stocks to the database
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

# Missing major ASX stocks that should be in the database
MISSING_STOCKS = {
    "WOW": 38.50,  # Woolworths Group
    "COL": 69.50,  # Coles Group
    "WES": 68.20,  # Wesfarmers
    "RIO": 112.30,  # Rio Tinto
    "FMG": 19.85,  # Fortescue Metals Group
    "NCM": 24.50,  # Newcrest Mining
    "STO": 8.95,  # Santos
    "ORG": 7.25,  # Origin Energy
    "OSH": 12.80,  # Oil Search
    "WTC": 94.50,  # WiseTech Global
    "CPU": 39.75,  # Computershare
    "COH": 21.40,  # Cochlear
    "SHL": 43.90,  # Sonic Healthcare
    "RMD": 33.20,  # ResMed
    "TWE": 12.60,  # Treasury Wine Estates
}


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


async def add_missing_stocks():
    """Add missing ASX stocks to the database"""
    print("🚀 Adding missing major ASX stocks to database...")

    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)

    try:
        # Check which stocks already exist
        existing_stocks = await conn.fetch(
            "SELECT DISTINCT stock_code FROM stock_prices"
        )
        existing_set = {row["stock_code"] for row in existing_stocks}

        print(f"📋 Existing stocks: {sorted(existing_set)}")

        # Filter to only stocks we need to add
        stocks_to_add = {
            code: price
            for code, price in MISSING_STOCKS.items()
            if code not in existing_set
        }

        if not stocks_to_add:
            print("✅ All stocks already exist in database!")
            return

        print(
            f"➕ Adding {len(stocks_to_add)} missing stocks: {list(stocks_to_add.keys())}"
        )

        total_records = 0

        for stock_code, base_price in stocks_to_add.items():
            print(f"📈 Generating data for {stock_code} (${base_price})...")

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

        # Verify updated data
        final_count = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")
        final_stocks = await conn.fetch(
            "SELECT DISTINCT stock_code FROM stock_prices ORDER BY stock_code"
        )

        print(f"\n🎉 Successfully added {total_records} new records!")
        print(f"📊 Total records in database: {final_count}")
        print(
            f"📈 All stocks now in database: {[row['stock_code'] for row in final_stocks]}"
        )

        # Show sample of WOW data to verify
        wow_sample = await conn.fetch(
            """
            SELECT stock_code, date, open, high, low, close, volume 
            FROM stock_prices 
            WHERE stock_code = 'WOW'
            ORDER BY date DESC 
            LIMIT 5
        """
        )

        if wow_sample:
            print(f"\n🎯 Sample WOW data:")
            print("Date       | Open   | High   | Low    | Close  | Volume")
            print("-----------+--------+--------+--------+--------+---------")
            for row in wow_sample:
                print(
                    f"{row['date']} | ${row['open']:<6} | ${row['high']:<6} | ${row['low']:<6} | ${row['close']:<6} | {row['volume']:>7,}"
                )

    except Exception as e:
        print(f"❌ Error: {e}")
        raise
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(add_missing_stocks())
