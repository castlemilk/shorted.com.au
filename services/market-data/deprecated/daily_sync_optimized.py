#!/usr/bin/env python3
"""
Optimized daily sync of ASX stock prices using batch downloads
Handles 1,800+ stocks efficiently without rate limiting
"""

import asyncio
import asyncpg
import yfinance as yf
import pandas as pd
from datetime import date, timedelta
import os
import sys
import time
from typing import List, Dict

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    print("❌ DATABASE_URL environment variable is required")
    sys.exit(1)

# Batch size for Yahoo Finance downloads
BATCH_SIZE = 100  # Download 100 stocks at a time
BATCH_DELAY = 2  # Seconds between batches


async def get_all_stock_codes(conn) -> List[str]:
    """Get all unique stock codes from the database"""
    rows = await conn.fetch(
        "SELECT DISTINCT stock_code FROM stock_prices ORDER BY stock_code"
    )
    return [row["stock_code"] for row in rows]


def fetch_batch_data(
    stock_codes: List[str], days_back: int = 5
) -> Dict[str, pd.DataFrame]:
    """
    Fetch data for multiple stocks in a single API call
    This is MUCH more efficient than individual requests
    """
    results = {}

    # Add .AX suffix for ASX stocks
    symbols = [f"{code}.AX" for code in stock_codes]

    try:
        end_date = date.today()
        start_date = end_date - timedelta(days=days_back)

        print(f"  📥 Fetching {len(symbols)} stocks from Yahoo Finance...")

        # Download multiple tickers at once (single API call!)
        data = yf.download(
            symbols,
            start=start_date,
            end=end_date,
            group_by="ticker",
            auto_adjust=False,
            threads=True,  # Use threading for faster downloads
            progress=False,
            show_errors=False,
        )

        # Process results
        if len(symbols) == 1:
            # Single ticker returns different structure
            if not data.empty and not data["Close"].isna().all():
                results[stock_codes[0]] = data
        else:
            # Multiple tickers
            for i, symbol in enumerate(symbols):
                stock_code = stock_codes[i]
                try:
                    # Check if symbol exists in data
                    if symbol in data.columns.levels[0]:
                        df = data[symbol]
                        if not df.empty and not df["Close"].isna().all():
                            results[stock_code] = df
                except Exception as e:
                    print(f"    ⚠️  Error processing {stock_code}: {e}")

        print(f"  ✅ Fetched {len(results)}/{len(stock_codes)} stocks successfully")
        return results

    except Exception as e:
        print(f"  ❌ Batch download failed: {e}")
        return {}


async def insert_stock_data(conn, stock_code: str, df: pd.DataFrame) -> int:
    """Insert stock data into database"""
    inserted = 0

    for idx, row in df.iterrows():
        # Skip rows with missing data
        if pd.isna(row["Close"]) or pd.isna(row["Open"]):
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
                idx.date(),
                round(float(row["Open"]), 2),
                round(float(row["High"]), 2),
                round(float(row["Low"]), 2),
                round(float(row["Close"]), 2),
                round(
                    float(row["Adj Close"] if "Adj Close" in row else row["Close"]), 2
                ),
                int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
            )
            inserted += 1
        except Exception as e:
            print(f"    ⚠️  Error inserting {stock_code} {idx.date()}: {e}")

    return inserted


async def sync_batch(conn, stock_codes: List[str], batch_num: int, total_batches: int):
    """Sync a batch of stocks"""
    print(f"\n📦 Batch {batch_num}/{total_batches} - {len(stock_codes)} stocks")

    # Fetch data for all stocks in this batch (single API call)
    batch_data = fetch_batch_data(stock_codes, days_back=5)

    if not batch_data:
        print("  ⚠️  No data fetched for this batch")
        return 0

    # Insert data for each stock
    total_inserted = 0
    for stock_code, df in batch_data.items():
        inserted = await insert_stock_data(conn, stock_code, df)
        total_inserted += inserted

    print(f"  ✅ Batch complete: {total_inserted} records inserted")
    return total_inserted


async def main():
    """Main sync function"""
    start_time = time.time()

    print("🚀 Starting optimized daily stock price sync")
    print(f"📊 Batch size: {BATCH_SIZE} stocks per batch")

    conn = await asyncpg.connect(DATABASE_URL)

    try:
        # Get all stock codes from database
        print("\n📋 Loading stock codes...")
        stock_codes = await get_all_stock_codes(conn)
        print(f"✅ Found {len(stock_codes)} stocks to sync")

        # Split into batches
        total_batches = (len(stock_codes) + BATCH_SIZE - 1) // BATCH_SIZE
        total_inserted = 0

        for i in range(0, len(stock_codes), BATCH_SIZE):
            batch = stock_codes[i : i + BATCH_SIZE]
            batch_num = (i // BATCH_SIZE) + 1

            inserted = await sync_batch(conn, batch, batch_num, total_batches)
            total_inserted += inserted

            # Rate limiting between batches
            if i + BATCH_SIZE < len(stock_codes):
                print(f"  ⏸️  Waiting {BATCH_DELAY}s before next batch...")
                time.sleep(BATCH_DELAY)

        elapsed = time.time() - start_time

        print(f"\n🎉 Sync complete!")
        print(f"📈 Total records inserted/updated: {total_inserted:,}")
        print(f"⏱️  Time elapsed: {elapsed:.1f}s ({elapsed/60:.1f} minutes)")
        print(f"🚀 Rate: {len(stock_codes)/elapsed*60:.0f} stocks/minute")

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
