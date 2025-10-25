#!/usr/bin/env python3
"""
Cloud Run service for daily ASX stock price sync
Provides HTTP endpoints for scheduled sync operations
"""

import os
import asyncio
import logging
from datetime import date, timedelta
from typing import Dict, List
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
import asyncpg
import yfinance as yf
import pandas as pd

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global database connection pool
db_pool = None

# Batch size for Yahoo Finance downloads
BATCH_SIZE = 20  # Reduced batch size to avoid Yahoo Finance rate limiting
BATCH_DELAY = 5  # Increased delay between batches to avoid rate limiting


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    global db_pool

    # Startup
    logger.info("Starting market data sync service...")

    # Initialize database connection pool
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise ValueError("DATABASE_URL environment variable is required")

    db_pool = await asyncpg.create_pool(
        db_url, min_size=1, max_size=5, command_timeout=60
    )

    logger.info("Database connection pool initialized")

    yield

    # Shutdown
    logger.info("Shutting down market data sync service...")
    if db_pool:
        await db_pool.close()
        logger.info("Database connection pool closed")


app = FastAPI(
    title="Market Data Sync Service",
    description="Automated daily sync of ASX stock prices",
    lifespan=lifespan,
)


class SyncResponse(BaseModel):
    status: str
    message: str
    records_processed: int
    batch_id: str | None = None


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
                "service": "market-data-sync",
            }
        else:
            return {"status": "unhealthy", "database": "not connected"}
    except Exception as e:
        return {"status": "unhealthy", "error": str(e)}


async def get_all_stock_codes() -> List[str]:
    """Get all unique stock codes from the database"""
    global db_pool
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT stock_code FROM stock_prices ORDER BY stock_code"
        )
        return [row["stock_code"] for row in rows]


def fetch_batch_data(
    stock_codes: List[str], days_back: int = 5
) -> Dict[str, pd.DataFrame]:
    """
    Fetch data for multiple stocks in a single API call
    """
    results = {}

    # Stock codes already have .AX suffix from database
    symbols = stock_codes

    try:
        end_date = date.today()
        start_date = end_date - timedelta(days=days_back)

        logger.info(f"Fetching {len(symbols)} stocks from Yahoo Finance...")

        # Download multiple tickers at once (single API call!)
        try:
            logger.info(
                f"Downloading {len(symbols)} symbols: {symbols[:5]}..."
            )  # Log first 5 symbols
            data = yf.download(
                symbols,
                start=start_date,
                end=end_date,
                group_by="ticker",
                auto_adjust=False,
                threads=False,  # Disable threading to avoid rate limiting
                progress=False,
                show_errors=True,  # Enable error reporting
            )
            logger.info(
                f"Raw data shape: {data.shape if hasattr(data, 'shape') else 'No shape'}"
            )
        except Exception as e:
            logger.error(f"Batch download failed: {e}")
            logger.info("Falling back to individual downloads...")

            # Fallback to individual downloads
            for symbol in symbols:
                try:
                    ticker = yf.Ticker(symbol)
                    individual_data = ticker.history(start=start_date, end=end_date)
                    if (
                        not individual_data.empty
                        and not individual_data["Close"].isna().all()
                    ):
                        results[symbol.replace(".AX", "")] = individual_data
                        logger.info(f"Successfully downloaded {symbol}")
                except Exception as individual_error:
                    logger.warning(f"Failed to download {symbol}: {individual_error}")

            logger.info(f"Individual downloads completed: {len(results)} stocks")
            return results

        # Process results
        logger.info(f"Processing results for {len(symbols)} symbols...")
        if len(symbols) == 1:
            # Single ticker returns different structure
            logger.info(f"Single ticker data - empty: {data.empty}")
            if not data.empty and not data["Close"].isna().all():
                results[stock_codes[0]] = data
                logger.info(f"Added single ticker {stock_codes[0]}")
        else:
            # Multiple tickers
            logger.info(
                f"Multiple tickers - columns: {len(data.columns) if hasattr(data, 'columns') else 'No columns'}"
            )
            for i, symbol in enumerate(symbols):
                stock_code = stock_codes[i]
                try:
                    # Check if symbol exists in data
                    if hasattr(data, "columns") and symbol in data.columns.levels[0]:
                        df = data[symbol]
                        logger.info(
                            f"Processing {stock_code} - empty: {df.empty}, close na: {df['Close'].isna().all() if not df.empty else 'N/A'}"
                        )
                        if not df.empty and not df["Close"].isna().all():
                            results[stock_code] = df
                            logger.info(f"Added {stock_code} to results")
                    else:
                        logger.warning(f"Symbol {symbol} not found in data columns")
                except Exception as e:
                    logger.warning(f"Error processing {stock_code}: {e}")

        logger.info(f"Fetched {len(results)}/{len(stock_codes)} stocks successfully")
        return results

    except Exception as e:
        logger.error(f"Batch download failed: {e}")
        return {}


async def insert_stock_data(stock_code: str, df: pd.DataFrame) -> int:
    """Insert stock data into database"""
    global db_pool
    inserted = 0

    async with db_pool.acquire() as conn:
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
                        float(row["Adj Close"] if "Adj Close" in row else row["Close"]),
                        2,
                    ),
                    int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
                )
                inserted += 1
            except Exception as e:
                logger.error(f"Error inserting {stock_code} {idx.date()}: {e}")

    return inserted


async def run_sync(days_back: int = 5) -> Dict[str, any]:
    """Run the sync process"""
    start_time = time.time()

    logger.info("Starting daily stock price sync")
    logger.info(f"Batch size: {BATCH_SIZE} stocks per batch")

    # Get all stock codes from database
    logger.info("Loading stock codes...")
    stock_codes = await get_all_stock_codes()
    logger.info(f"Found {len(stock_codes)} stocks to sync")

    # Split into batches
    total_batches = (len(stock_codes) + BATCH_SIZE - 1) // BATCH_SIZE
    total_inserted = 0

    for i in range(0, len(stock_codes), BATCH_SIZE):
        batch = stock_codes[i : i + BATCH_SIZE]
        batch_num = (i // BATCH_SIZE) + 1

        logger.info(
            f"Processing batch {batch_num}/{total_batches} - {len(batch)} stocks"
        )

        # Fetch data for all stocks in this batch (single API call)
        batch_data = fetch_batch_data(batch, days_back=days_back)

        if not batch_data:
            logger.warning("No data fetched for this batch")
            continue

        # Insert data for each stock
        for stock_code, df in batch_data.items():
            inserted = await insert_stock_data(stock_code, df)
            total_inserted += inserted

        # Rate limiting between batches
        if i + BATCH_SIZE < len(stock_codes):
            logger.info(f"Waiting {BATCH_DELAY}s before next batch...")
            await asyncio.sleep(BATCH_DELAY)

    elapsed = time.time() - start_time

    logger.info("Sync complete!")
    logger.info(f"Total records inserted/updated: {total_inserted:,}")
    logger.info(f"Time elapsed: {elapsed:.1f}s ({elapsed/60:.1f} minutes)")

    return {
        "total_records": total_inserted,
        "total_stocks": len(stock_codes),
        "elapsed_time": elapsed,
        "batches_processed": total_batches,
    }


@app.post("/sync")
async def sync_endpoint(background_tasks: BackgroundTasks):
    """
    Trigger daily sync of all stocks
    This endpoint is called by Cloud Scheduler
    """
    try:
        # Run sync in background
        background_tasks.add_task(run_sync, days_back=5)

        return SyncResponse(
            status="accepted",
            message="Daily sync started for all stocks",
            records_processed=0,
            batch_id="daily-sync-" + str(int(time.time())),
        )

    except Exception as e:
        logger.error(f"Sync failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sync-now")
async def sync_now_endpoint():
    """
    Run sync immediately (for testing)
    """
    try:
        result = await run_sync(days_back=5)

        return SyncResponse(
            status="completed",
            message=f"Sync completed for {result['total_stocks']} stocks",
            records_processed=result["total_records"],
            batch_id="manual-sync-" + str(int(time.time())),
        )

    except Exception as e:
        logger.error(f"Sync failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "Market Data Sync Service",
        "description": "Automated daily sync of ASX stock prices",
        "endpoints": ["/health", "/sync", "/sync-now"],
        "docs": "/docs",
    }


if __name__ == "__main__":
    import time
    import uvicorn

    port = int(os.getenv("PORT", 8080))
    logger.info(f"Starting server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
