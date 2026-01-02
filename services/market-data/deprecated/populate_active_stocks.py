#!/usr/bin/env python3
"""
Populate historical price data for ACTIVE stocks only (stocks with recent short data).
This is much faster than trying to populate all historical stocks.
"""
import asyncio
import asyncpg
from datetime import date, timedelta
import yfinance as yf
import pandas as pd
import time
import os
from typing import List, Dict, Set

# Database configuration
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")


async def get_active_stocks(days: int = 90) -> Set[str]:
    """Get stocks with short data in the last N days (actively traded)."""
    conn = await asyncpg.connect(DATABASE_URL)

    try:
        stocks = await conn.fetch(
            f'''
            SELECT DISTINCT "PRODUCT_CODE" 
            FROM shorts 
            WHERE "DATE" >= CURRENT_DATE - INTERVAL '{days} days'
            ORDER BY "PRODUCT_CODE"
            '''
        )
        stock_codes = {row["PRODUCT_CODE"] for row in stocks}
        print(f"📊 Found {len(stock_codes)} active stocks (last {days} days)")
        return stock_codes
    finally:
        await conn.close()


async def check_existing_data(conn, stock_code: str) -> bool:
    """Check if stock already has substantial historical data."""
    existing = await conn.fetchrow(
        """
        SELECT COUNT(*) as count, MIN(date) as earliest, MAX(date) as latest
        FROM stock_prices WHERE stock_code = $1
        """,
        stock_code,
    )

    # Skip if we already have more than 500 records (likely already has years of data)
    if existing["count"] and existing["count"] > 500:
        years = (
            (existing["latest"] - existing["earliest"]).days / 365.25
            if existing["earliest"]
            else 0
        )
        print(
            f"  ⏭️  Skipping {stock_code} - already has {existing['count']:,} records ({years:.1f} years)"
        )
        return True
    return False


def fetch_stock_price_data(stock_code: str, years: int = 10) -> List[Dict]:
    """Fetch historical price data from Yahoo Finance."""
    yf_ticker = f"{stock_code}.AX"

    try:
        print(f"  📈 Fetching {years} years of data for {stock_code}...")

        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=years * 365)

        hist = ticker.history(start=start_date, end=end_date, interval="1d")

        if hist.empty:
            print(f"    ⚠️  No data available for {yf_ticker}")
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

        print(f"    ✅ Fetched {len(data)} records")
        return data

    except Exception as e:
        print(f"    ❌ Error fetching {stock_code}: {e}")
        return []


async def insert_stock_data(conn, data: List[Dict]) -> int:
    """Insert stock price data into database."""
    if not data:
        return 0

    try:
        records = [
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
            for d in data
        ]

        # Use COPY for fast bulk insert
        inserted = await conn.copy_records_to_table(
            "stock_prices",
            records=records,
            columns=[
                "stock_code",
                "date",
                "open",
                "high",
                "low",
                "close",
                "adjusted_close",
                "volume",
            ],
        )

        # Parse COPY result
        count = int(inserted.split()[-1]) if inserted else len(records)
        return count

    except Exception as e:
        print(f"    ⚠️  Insert error (likely duplicates): {str(e)[:100]}")
        return 0


async def populate_stock(conn, stock_code: str) -> tuple[int, str]:
    """Populate a single stock's historical data."""
    print(f"\n[{stock_code}]")

    # Check if already populated
    if await check_existing_data(conn, stock_code):
        return 0, "skipped"

    # Fetch data from Yahoo Finance
    data = fetch_stock_price_data(stock_code)

    if not data:
        return 0, "no_data"

    # Insert into database
    inserted = await insert_stock_data(conn, data)

    if inserted > 0:
        print(f"    ✅ Inserted {inserted:,} records")
        return inserted, "success"
    else:
        return 0, "failed"


async def main():
    """Main function to populate all active stocks."""
    print("🚀 Populating historical price data for ACTIVE stocks\n")

    # Get active stocks (last 90 days)
    active_stocks = await get_active_stocks(days=90)

    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)

    try:
        total_inserted = 0
        successful = 0
        skipped = 0
        no_data = 0
        failed = 0

        for i, stock_code in enumerate(sorted(active_stocks), 1):
            print(f"\n[{i:4d}/{len(active_stocks)}] Processing {stock_code}")

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
                print(f"    ❌ Failed: {e}")
                failed += 1

            # Rate limiting - be nice to Yahoo Finance
            time.sleep(0.5)

        # Print summary
        print("\n" + "=" * 60)
        print("📊 POPULATION COMPLETE")
        print("=" * 60)
        print(f"✅ Successful: {successful}")
        print(f"⏭️  Skipped (already populated): {skipped}")
        print(f"⚠️  No data available: {no_data}")
        print(f"❌ Failed: {failed}")
        print(f"➕ Total records inserted: {total_inserted:,}")
        print("=" * 60)

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())

