#!/usr/bin/env python3
"""
Backfill missing historical data for stocks that don't have any data yet
"""

import os
import asyncio
import asyncpg
import yfinance as yf
from datetime import datetime, timedelta
from typing import List, Set
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Database connection string
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres",
)


async def get_all_stock_codes(pool: asyncpg.Pool) -> Set[str]:
    """Get all stock codes from company-metadata table"""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            'SELECT DISTINCT stock_code FROM "company-metadata" WHERE stock_code IS NOT NULL'
        )
        return {row["stock_code"] for row in rows if row["stock_code"]}


async def get_stocks_with_data(pool: asyncpg.Pool) -> Set[str]:
    """Get stock codes that already have price data (normalized without .AX suffix)"""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT REPLACE(stock_code, '.AX', '') as stock_code FROM stock_prices"
        )
        return {row["stock_code"] for row in rows}


async def sync_stock(pool: asyncpg.Pool, stock_code: str, days_back: int = 730):
    """Sync historical data for a single stock"""
    try:
        symbol = f"{stock_code}.AX"
        end_date = datetime.now()
        start_date = end_date - timedelta(days=days_back)

        logger.info(
            f"Fetching {symbol} data from {start_date.date()} to {end_date.date()}..."
        )

        # Fetch data from Yahoo Finance
        ticker = yf.Ticker(symbol)
        df = ticker.history(start=start_date, end=end_date)

        if df.empty:
            logger.warning(f"No data found for {symbol}")
            return 0

        logger.info(f"Found {len(df)} data points for {symbol}, inserting...")

        # Insert into database
        inserted = 0
        async with pool.acquire() as conn:
            for idx, row in df.iterrows():
                try:
                    await conn.execute(
                        """
                        INSERT INTO stock_prices 
                        (stock_code, date, open, high, low, close, volume)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (stock_code, date) DO UPDATE SET
                            open = EXCLUDED.open,
                            high = EXCLUDED.high,
                            low = EXCLUDED.low,
                            close = EXCLUDED.close,
                            volume = EXCLUDED.volume,
                            updated_at = CURRENT_TIMESTAMP
                        """,
                        stock_code,
                        idx.date(),
                        float(row["Open"]),
                        float(row["High"]),
                        float(row["Low"]),
                        float(row["Close"]),
                        int(row["Volume"]),
                    )
                    inserted += 1
                except Exception as e:
                    logger.error(f"Error inserting {stock_code} {idx.date()}: {e}")

        logger.info(f"✅ Inserted {inserted} records for {stock_code}")
        return inserted

    except Exception as e:
        logger.error(f"❌ Error syncing {stock_code}: {e}")
        return 0


async def main():
    """Main function to backfill missing stocks"""
    logger.info("Starting backfill for missing stocks...")

    # Create database connection pool
    pool = await asyncpg.create_pool(
        DATABASE_URL, min_size=2, max_size=5, server_settings={"gssencmode": "disable"}
    )

    try:
        # Get all stock codes and those with data
        all_stocks = await get_all_stock_codes(pool)
        stocks_with_data = await get_stocks_with_data(pool)

        # Find missing stocks
        missing_stocks = all_stocks - stocks_with_data

        logger.info(f"Total stocks in metadata: {len(all_stocks)}")
        logger.info(f"Stocks with price data: {len(stocks_with_data)}")
        logger.info(f"Stocks missing data: {len(missing_stocks)}")

        if not missing_stocks:
            logger.info("No missing stocks found. All stocks have data!")
            return

        # Show first 10 missing stocks
        missing_list = sorted(list(missing_stocks))
        logger.info(f"First 10 missing stocks: {missing_list[:10]}")

        # Ask for batch size
        print(f"\nTotal missing stocks: {len(missing_stocks)}")
        print("Options:")
        print("  1. Test batch (10 stocks)")
        print("  2. Small batch (50 stocks)")
        print("  3. Medium batch (200 stocks)")
        print("  4. Full backfill (all stocks)")
        print("  0. Cancel")

        choice = input("\nSelect option (0-4): ").strip()

        if choice == "0":
            logger.info("Backfill cancelled")
            return
        elif choice == "1":
            batch_size = 10
        elif choice == "2":
            batch_size = 50
        elif choice == "3":
            batch_size = 200
        elif choice == "4":
            batch_size = len(missing_stocks)
        else:
            logger.error("Invalid choice")
            return

        missing_list = missing_list[:batch_size]
        logger.info(f"\nProcessing {len(missing_list)} stocks...")

        # Backfill missing stocks
        total_inserted = 0
        for i, stock_code in enumerate(missing_list, 1):
            logger.info(f"[{i}/{len(missing_list)}] Processing {stock_code}...")
            inserted = await sync_stock(pool, stock_code)
            total_inserted += inserted

            # Add a small delay to avoid rate limiting
            await asyncio.sleep(0.5)

        logger.info(
            f"\n✅ Backfill complete! Inserted {total_inserted} total records for {len(missing_list)} stocks"
        )

    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
