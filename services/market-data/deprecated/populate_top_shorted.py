#!/usr/bin/env python3
"""
Populate historical price data for the TOP shorted stocks.
This ensures the most important stocks for the application have price data.
"""
import asyncio
import asyncpg
from datetime import date, timedelta
import yfinance as yf
import pandas as pd
import time
import os
from typing import List, Dict

# Database configuration
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")


async def get_top_shorted_stocks(limit: int = 200) -> List[str]:
    """Get the top N most shorted stocks from latest data."""
    conn = await asyncpg.connect(DATABASE_URL)

    try:
        stocks = await conn.fetch(
            f'''
            SELECT "PRODUCT_CODE"
            FROM shorts
            WHERE "DATE" = (SELECT MAX("DATE") FROM shorts)
            AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
            ORDER BY "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
            LIMIT $1
            ''',
            limit
        )
        stock_codes = [row["PRODUCT_CODE"] for row in stocks]
        print(f"📊 Found top {len(stock_codes)} most shorted stocks")
        return stock_codes
    finally:
        await conn.close()


async def check_existing_data(conn, stock_code: str) -> tuple[bool, int]:
    """Check if stock already has data."""
    existing = await conn.fetchrow(
        "SELECT COUNT(*) as count FROM stock_prices WHERE stock_code = $1",
        stock_code,
    )
    count = existing["count"] if existing else 0
    return count > 0, count


def fetch_stock_price_data(stock_code: str, years: int = 10) -> List[Dict]:
    """Fetch historical price data from Yahoo Finance."""
    yf_ticker = f"{stock_code}.AX"

    try:
        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=years * 365)

        hist = ticker.history(start=start_date, end=end_date, interval="1d")

        if hist.empty:
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

        return data

    except Exception as e:
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

        count = int(inserted.split()[-1]) if inserted else len(records)
        return count

    except Exception:
        return 0


async def populate_stock(conn, stock_code: str) -> tuple[int, str]:
    """Populate a single stock's historical data."""
    # Check if already populated
    has_data, count = await check_existing_data(conn, stock_code)
    if has_data:
        print(f"  ⏭️  {stock_code}: Already has {count} records")
        return 0, "skipped"

    # Fetch data
    print(f"  📈 {stock_code}: Fetching data...", end="", flush=True)
    data = fetch_stock_price_data(stock_code)

    if not data:
        print(f" ⚠️  No data available")
        return 0, "no_data"

    # Insert
    inserted = await insert_stock_data(conn, data)
    if inserted > 0:
        print(f" ✅ Inserted {inserted:,} records")
        return inserted, "success"
    else:
        print(f" ❌ Insert failed")
        return 0, "failed"


async def main():
    """Main function."""
    print("🚀 Populating TOP SHORTED STOCKS with price data\n")

    # Get top 200 most shorted stocks
    top_stocks = await get_top_shorted_stocks(limit=200)
    print(f"📋 Processing {len(top_stocks)} stocks...\n")

    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)

    try:
        total_inserted = 0
        successful = 0
        skipped = 0
        no_data = 0
        failed = 0

        for i, stock_code in enumerate(top_stocks, 1):
            print(f"[{i:3d}/{len(top_stocks)}]", end=" ")

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
                print(f"  ❌ {stock_code}: Error - {str(e)[:50]}")
                failed += 1

            # Rate limiting
            time.sleep(0.5)

        # Print summary
        print("\n" + "=" * 60)
        print("📊 POPULATION COMPLETE")
        print("=" * 60)
        print(f"✅ Successful: {successful}")
        print(f"⏭️  Skipped (already had data): {skipped}")
        print(f"⚠️  No data available: {no_data}")
        print(f"❌ Failed: {failed}")
        print(f"➕ Total records inserted: {total_inserted:,}")
        print(f"📈 Coverage: {successful + skipped}/{len(top_stocks)} top shorted stocks")
        print("=" * 60)

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())

