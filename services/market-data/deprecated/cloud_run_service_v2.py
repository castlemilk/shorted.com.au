#!/usr/bin/env python3
"""
Cloud Run service for daily stock price synchronization
Optimized for individual downloads to avoid Yahoo Finance API issues
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import date, timedelta
from typing import Dict, List

import asyncpg
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global database connection pool
db_pool = None

# Configuration for individual downloads
BATCH_SIZE = 10  # Smaller batches for individual downloads
BATCH_DELAY = 2  # Delay between batches


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    global db_pool

    # Startup
    logger.info("Starting market data sync service...")

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL environment variable is required")

    db_pool = await asyncpg.create_pool(database_url, min_size=1, max_size=5)
    logger.info("Database connection pool initialized")

    yield

    # Shutdown
    if db_pool:
        await db_pool.close()
        logger.info("Database connection pool closed")


app = FastAPI(
    title="Market Data Sync Service",
    description="Daily stock price synchronization service",
    version="2.0.0",
    lifespan=lifespan,
)


async def get_all_stock_codes() -> List[str]:
    """Get all stock codes from the database"""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT stock_code FROM stock_prices ORDER BY stock_code"
        )
        return [row["stock_code"] for row in rows]


async def fetch_individual_data(stock_code: str, days_back: int = 5) -> pd.DataFrame:
    """
    Fetch data for a single stock with retries
    """
    # Stock codes already have .AX suffix from database
    symbol = stock_code

    try:
        ticker = yf.Ticker(symbol)
        end_date = date.today()
        start_date = end_date - timedelta(days=days_back)

        data = ticker.history(start=start_date, end=end_date)

        if not data.empty and not data["Close"].isna().all():
            logger.info(f"Successfully downloaded {symbol} - {len(data)} records")
            return data
        else:
            logger.warning(f"No data returned for {symbol}")
            return pd.DataFrame()

    except Exception as e:
        logger.warning(f"Failed to download {symbol}: {e}")
        return pd.DataFrame()


async def insert_stock_data(data: pd.DataFrame, stock_code: str, database_url: str):
    """Insert stock data into the database"""
    if data.empty:
        return

    async with db_pool.acquire() as conn:
        records = []
        for date_idx, row in data.iterrows():
            records.append(
                {
                    "stock_code": stock_code,
                    "date": date_idx.date(),
                    "open": float(row["Open"]),
                    "high": float(row["High"]),
                    "low": float(row["Low"]),
                    "close": float(row["Close"]),
                    "volume": int(row["Volume"]) if pd.notna(row["Volume"]) else 0,
                    "adjusted_close": float(
                        row["Close"]
                    ),  # Using close as adjusted_close for simplicity
                }
            )

        if records:
            await conn.executemany(
                """
                INSERT INTO stock_prices (stock_code, date, open, high, low, close, volume, adjusted_close)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (stock_code, date) DO UPDATE SET
                    open = EXCLUDED.open,
                    high = EXCLUDED.high,
                    low = EXCLUDED.low,
                    close = EXCLUDED.close,
                    volume = EXCLUDED.volume,
                    adjusted_close = EXCLUDED.adjusted_close
                """,
                [
                    (
                        r["stock_code"],
                        r["date"],
                        r["open"],
                        r["high"],
                        r["low"],
                        r["close"],
                        r["volume"],
                        r["adjusted_close"],
                    )
                    for r in records
                ],
            )
            logger.info(f"Inserted {len(records)} records for {stock_code}")


async def sync_batch(stock_codes: List[str], days_back: int = 5) -> int:
    """Sync a batch of stocks"""
    total_records = 0

    for i, stock_code in enumerate(stock_codes):
        try:
            logger.info(f"Processing {stock_code} ({i+1}/{len(stock_codes)})")

            # Fetch data
            data = await fetch_individual_data(stock_code, days_back)

            if not data.empty:
                # Insert data
                await insert_stock_data(data, stock_code, os.getenv("DATABASE_URL"))
                total_records += len(data)

            # Small delay to avoid rate limiting
            if i < len(stock_codes) - 1:
                await asyncio.sleep(0.5)

        except Exception as e:
            logger.error(f"Error processing {stock_code}: {e}")
            continue

    return total_records


async def main_sync_logic():
    """Main sync logic"""
    logger.info("Starting daily stock price sync")

    # Get all stock codes
    stock_codes = await get_all_stock_codes()
    logger.info(f"Found {len(stock_codes)} stocks to sync")

    # Process in batches
    total_records = 0
    batch_count = 0

    for i in range(0, len(stock_codes), BATCH_SIZE):
        batch = stock_codes[i : i + BATCH_SIZE]
        batch_count += 1

        logger.info(f"Processing batch {batch_count} - {len(batch)} stocks")

        records = await sync_batch(batch)
        total_records += records

        logger.info(f"Batch {batch_count} completed - {records} records added")

        # Delay between batches
        if i + BATCH_SIZE < len(stock_codes):
            logger.info(f"Waiting {BATCH_DELAY} seconds before next batch...")
            await asyncio.sleep(BATCH_DELAY)

    logger.info(f"Sync completed - {total_records} total records processed")
    return total_records


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    try:
        if db_pool:
            async with db_pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
            return {
                "status": "healthy",
                "database": "connected",
                "service": "market-data-sync-v2",
            }
        else:
            return {"status": "unhealthy", "database": "not connected"}
    except Exception as e:
        return {"status": "unhealthy", "error": str(e)}


@app.post("/sync")
async def trigger_sync():
    """Trigger the daily sync"""
    try:
        logger.info("Sync endpoint triggered")

        # Run sync in background
        total_records = await main_sync_logic()

        return {
            "status": "completed",
            "message": "Daily sync completed successfully",
            "records_processed": total_records,
        }

    except Exception as e:
        logger.error(f"Sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
