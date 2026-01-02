#!/usr/bin/env python3
"""
Quickly populate specific stocks that are missing historical data.
This script can be used to immediately fix missing stocks like IEL.
"""
import asyncio
import asyncpg
from datetime import date, timedelta
import yfinance as yf
import pandas as pd
import os
import sys

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    print("❌ DATABASE_URL environment variable is required")
    sys.exit(1)


async def populate_stock(conn, stock_code: str, years: int = 10):
    """Populate historical data for a single stock."""
    print(f"\n📊 Processing {stock_code}...")

    # Check if already has data
    existing = await conn.fetchval(
        "SELECT COUNT(*) FROM stock_prices WHERE stock_code = $1", stock_code
    )

    if existing and existing > 100:
        print(f"  ⏭️  Already has {existing:,} records - skipping")
        return 0

    # Fetch from Yahoo Finance
    print(f"  📥 Fetching {years} years from Yahoo Finance...")
    yf_ticker = f"{stock_code}.AX"

    try:
        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=years * 365)

        hist = ticker.history(start=start_date, end=end_date, interval="1d")

        if hist.empty:
            print(f"  ⚠️  No data available from Yahoo Finance")
            return 0

        print(f"  ✅ Fetched {len(hist)} records")

        # Insert data
        inserted = 0
        for date_idx, row in hist.iterrows():
            if pd.isna(row["Open"]) or pd.isna(row["Close"]):
                continue

            try:
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
                    stock_code,
                    date_idx.date(),
                    round(float(row["Open"]), 2),
                    round(float(row["High"]), 2),
                    round(float(row["Low"]), 2),
                    round(float(row["Close"]), 2),
                    round(float(row["Close"]), 2),
                    int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
                )
                inserted += 1
            except Exception as e:
                print(f"  ⚠️  Error inserting record: {e}")
                continue

        print(f"  💾 Inserted {inserted:,} records")
        return inserted

    except Exception as e:
        print(f"  ❌ Error: {e}")
        return 0


async def main():
    """Main function to populate specific stocks."""
    # List of stocks to populate - add more as needed
    stocks_to_populate = [
        "IEL",  # User's requested stock
        # Add more missing stocks here if needed
    ]

    print("=" * 70)
    print("🚀 POPULATE SPECIFIC MISSING STOCKS")
    print("=" * 70)
    print(f"\n🎯 Target stocks: {', '.join(stocks_to_populate)}")
    print(f"📈 Data source: Yahoo Finance (.AX suffix)")
    print(f"📅 Period: 10 years of daily data")
    print()

    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)

    try:
        total_inserted = 0
        successful = 0

        for stock_code in stocks_to_populate:
            inserted = await populate_stock(conn, stock_code)
            if inserted > 0:
                total_inserted += inserted
                successful += 1

        print("\n" + "=" * 70)
        print("📊 COMPLETE")
        print("=" * 70)
        print(f"✅ Successful: {successful}/{len(stocks_to_populate)}")
        print(f"➕ Total records inserted: {total_inserted:,}")
        print("=" * 70)

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
