#!/usr/bin/env python3
"""
Populate historical price data for ALL ASX stocks.
Uses the official ASX company list CSV as the source of truth.

This is the correct approach - two independent jobs:
1. Sync short data (already exists)
2. Load historical price data for ALL ASX stocks (this script)
"""
import asyncio
import asyncpg
from datetime import date, timedelta
import yfinance as yf
import pandas as pd
import time
import os
from typing import List, Dict
from pathlib import Path

# Database configuration
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")

# Path to ASX company list
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
ASX_LIST_PATH = (
    PROJECT_ROOT
    / "analysis"
    / "data"
    / "ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv"
)


def load_asx_stocks() -> List[str]:
    """Load all ASX stock codes from the official ASX company list."""
    try:
        df = pd.read_csv(ASX_LIST_PATH)
        stock_codes = df["ASX code"].unique().tolist()
        print(f"📊 Loaded {len(stock_codes)} ASX stocks from {ASX_LIST_PATH.name}")
        return sorted(stock_codes)
    except Exception as e:
        print(f"❌ Failed to load ASX list: {e}")
        print(f"   Expected file at: {ASX_LIST_PATH}")
        raise


async def check_existing_data(conn, stock_code: str) -> bool:
    """Check if stock already has substantial historical data."""
    existing = await conn.fetchrow(
        """
        SELECT COUNT(*) as count, MIN(date) as earliest, MAX(date) as latest
        FROM stock_prices WHERE stock_code = $1
        """,
        stock_code,
    )

    # Skip if we already have more than 1000 records (likely already has years of data)
    if existing["count"] and existing["count"] > 1000:
        years = (
            (existing["latest"] - existing["earliest"]).days / 365.25
            if existing["earliest"]
            else 0
        )
        print(
            f"  ⏭️  Skipping - already has {existing['count']:,} records ({years:.1f} years)"
        )
        return True
    return False


def fetch_stock_price_data(stock_code: str, years: int = 10) -> List[Dict]:
    """Fetch historical price data from Yahoo Finance."""
    # Add .AX suffix for ASX stocks
    yf_ticker = f"{stock_code}.AX"

    try:
        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=years * 365)

        hist = ticker.history(start=start_date, end=end_date, interval="1d")

        if hist.empty:
            print(f"  ⚠️  No data available from Yahoo Finance")
            return []

        # Convert to our format
        data = []
        for date_idx, row in hist.iterrows():
            if pd.isna(row["Open"]) or pd.isna(row["Close"]):
                continue

            data.append(
                {
                    "stock_code": stock_code,
                    "date": date_idx.date(),
                    "open": round(float(row["Open"]), 2),
                    "high": round(float(row["High"]), 2),
                    "low": round(float(row["Low"]), 2),
                    "close": round(float(row["Close"]), 2),
                    "adjusted_close": round(float(row["Close"]), 2),
                    "volume": int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
                }
            )

        print(f"  ✅ Fetched {len(data)} records ({years} years)")
        return data

    except Exception as e:
        print(f"  ❌ Error: {e}")
        return []


async def insert_price_data(conn, data: List[Dict]) -> int:
    """Insert price data into the database."""
    if not data:
        return 0

    inserted = 0
    batch_size = 100

    for i in range(0, len(data), batch_size):
        batch = data[i : i + batch_size]

        try:
            await conn.executemany(
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
                [
                    (
                        d["stock_code"],
                        d["date"],
                        d["open"],
                        d["high"],
                        d["low"],
                        d["close"],
                        d["adjusted_close"],
                        d["volume"],
                    )
                    for d in batch
                ],
            )
            inserted += len(batch)
        except Exception as e:
            print(f"  ❌ Error inserting batch: {e}")

    if inserted > 0:
        print(f"  💾 Inserted {inserted:,} records into database")

    return inserted


async def populate_stock(conn, stock_code: str) -> tuple[int, str]:
    """Populate historical data for a single stock."""
    # Check if already populated
    if await check_existing_data(conn, stock_code):
        return 0, "skipped"

    # Fetch data
    data = fetch_stock_price_data(stock_code, years=10)

    if not data:
        return 0, "no_data"

    # Insert data
    inserted = await insert_price_data(conn, data)

    return inserted, "success" if inserted > 0 else "failed"


async def main():
    """Main function to populate all ASX stocks."""
    print("=" * 70)
    print("🚀 POPULATE HISTORICAL PRICE DATA FOR ALL ASX STOCKS")
    print("=" * 70)
    print()
    print("This script:")
    print("  1. Loads all ASX stocks from the official company list")
    print("  2. Fetches 10 years of historical data from Yahoo Finance")
    print("  3. Stores in the stock_prices table")
    print()
    print("=" * 70)
    print()

    # Load all ASX stocks from CSV
    all_stocks = load_asx_stocks()

    print(f"\n🎯 Target: {len(all_stocks)} ASX stocks")
    print(f"📈 Data source: Yahoo Finance (.AX suffix)")
    print(f"📅 Period: 10 years of daily data")
    print()

    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)

    try:
        total_inserted = 0
        successful = 0
        skipped = 0
        no_data = 0
        failed = 0

        start_time = time.time()

        for i, stock_code in enumerate(all_stocks, 1):
            print(f"[{i:4d}/{len(all_stocks)}] {stock_code}")

            try:
                inserted, status = await populate_stock(conn, stock_code)

                if status == "success":
                    total_inserted += inserted
                    successful += 1
                elif status == "skipped":
                    skipped += 1
                elif status == "no_data":
                    no_data += 1
                else:
                    failed += 1

            except Exception as e:
                print(f"  ❌ Failed: {e}")
                failed += 1

            # Rate limiting - be nice to Yahoo Finance
            time.sleep(0.5)

            # Progress update every 50 stocks
            if i % 50 == 0:
                elapsed = time.time() - start_time
                rate = i / elapsed
                remaining = len(all_stocks) - i
                eta = remaining / rate if rate > 0 else 0
                print(
                    f"\n📊 Progress: {i}/{len(all_stocks)} ({i/len(all_stocks)*100:.1f}%)"
                )
                print(f"⏱️  Rate: {rate:.1f} stocks/sec | ETA: {eta/60:.1f} min\n")

        # Print summary
        elapsed_total = time.time() - start_time
        print("\n" + "=" * 70)
        print("📊 POPULATION COMPLETE")
        print("=" * 70)
        print(f"⏱️  Total time: {elapsed_total/60:.1f} minutes")
        print(f"✅ Successful: {successful:,}")
        print(f"⏭️  Skipped (already populated): {skipped:,}")
        print(f"⚠️  No data available: {no_data:,}")
        print(f"❌ Failed: {failed:,}")
        print(f"➕ Total records inserted: {total_inserted:,}")
        print("=" * 70)

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
