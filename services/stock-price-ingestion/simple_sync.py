#!/usr/bin/env python3
"""Simplified stock price sync service for Cloud Run"""

import os
import asyncio
import asyncpg
import yfinance as yf
from datetime import datetime, date, timedelta
from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional
import logging
import pandas as pd
from pathlib import Path

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Stock Price Sync Service")

# Database URL from environment
DATABASE_URL = os.getenv("DATABASE_URL")


def load_all_asx_stocks() -> List[str]:
    """Load all ASX stock codes from the official ASX API (live data)"""
    # Official ASX API endpoint - publicly available from their website
    ASX_API_URL = "https://asx.api.markitdigital.com/asx-research/1.0/companies/directory/file"
    ASX_API_TOKEN = "83ff96335c2d45a094df02a206a39ff4"
    
    try:
        import requests
        from io import StringIO
        
        logger.info("📡 Fetching live ASX company list from official API...")
        response = requests.get(
            ASX_API_URL,
            params={"access_token": ASX_API_TOKEN},
            timeout=30
        )
        response.raise_for_status()
        
        # Parse CSV response
        df = pd.read_csv(StringIO(response.text))
        
        if 'ASX code' not in df.columns:
            logger.error("API response missing 'ASX code' column")
            raise ValueError("Invalid API response format")
        
        # Get all stock codes, clean and filter
        stock_codes = (
            df["ASX code"]
            .dropna()
            .str.strip()
            .str.upper()
            .unique()
            .tolist()
        )
        
        # Filter out invalid codes (should be 3-4 letters, alphabetic)
        stock_codes = [
            code for code in stock_codes 
            if len(code) >= 3 and len(code) <= 4 and code.isalpha()
        ]
        
        logger.info(f"✅ Loaded {len(stock_codes)} ASX stocks from live API")
        return sorted(stock_codes)
        
    except Exception as e:
        logger.error(f"❌ Failed to fetch from ASX API: {e}")
        logger.warning("⚠️  Falling back to local CSV file...")
        return load_asx_stocks_from_csv()

def load_asx_stocks_from_csv() -> List[str]:
    """Fallback: Load ASX stocks from local CSV file"""
    possible_paths = [
        Path(__file__).parent.parent.parent
        / "analysis"
        / "data"
        / "ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv",
        Path("/app/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv"),
        Path("../../analysis/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv"),
    ]

    csv_path = None
    for path in possible_paths:
        if path.exists():
            csv_path = path
            break

    if not csv_path:
        logger.error("CSV file not found either - no stock data available")
        return []

    try:
        df = pd.read_csv(csv_path, engine="python")

        if "ASX code" not in df.columns:
            logger.error("CSV missing 'ASX code' column")
            return []

        stock_codes = (
            df["ASX code"]
            .dropna()
            .str.strip()
            .str.upper()
            .unique()
            .tolist()
        )

        stock_codes = [
            code
            for code in stock_codes
            if len(code) >= 3 and len(code) <= 4 and code.isalpha()
        ]

        logger.info(f"Loaded {len(stock_codes)} ASX stocks from local CSV")
        return sorted(stock_codes)

    except Exception as e:
        logger.error(f"Error loading from CSV: {e}")
        return []


class SyncRequest(BaseModel):
    symbols: List[str]
    days_back: int = 5


async def get_db_pool():
    """Create database connection pool"""
    return await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)


async def sync_stock(pool: asyncpg.Pool, symbol: str, days_back: int):
    """Sync a single stock's data"""
    try:
        # Add .AX suffix for ASX stocks if not present
        if not symbol.endswith(".AX"):
            symbol = f"{symbol}.AX"

        logger.info(f"Syncing {symbol} for last {days_back} days")

        # Fetch data from Yahoo Finance
        ticker = yf.Ticker(symbol)
        end_date = datetime.now()
        start_date = end_date - timedelta(days=days_back)

        df = ticker.history(start=start_date, end=end_date)

        if df.empty:
            logger.warning(f"No data found for {symbol}")
            return 0

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
                        symbol,
                        idx.date(),
                        float(row["Open"]),
                        float(row["High"]),
                        float(row["Low"]),
                        float(row["Close"]),
                        int(row["Volume"]),
                    )
                    inserted += 1
                except Exception as e:
                    logger.error(f"Error inserting {symbol} {idx.date()}: {e}")

        logger.info(f"Inserted {inserted} records for {symbol}")
        return inserted

    except Exception as e:
        logger.error(f"Error syncing {symbol}: {e}")
        return 0


async def sync_all_stocks(symbols: List[str], days_back: int):
    """Sync multiple stocks"""
    pool = await get_db_pool()

    try:
        tasks = []
        for symbol in symbols:
            tasks.append(sync_stock(pool, symbol, days_back))

        results = await asyncio.gather(*tasks)
        total_inserted = sum(results)

        logger.info(f"Sync complete: {total_inserted} total records inserted")
        return total_inserted

    finally:
        await pool.close()


@app.get("/health")
async def health():
    """Health check endpoint"""
    try:
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        await pool.close()
        return {"status": "healthy", "database": "connected"}
    except Exception as e:
        return {"status": "unhealthy", "database": "error", "error": str(e)}


@app.post("/sync")
async def sync(request: SyncRequest, background_tasks: BackgroundTasks):
    """Sync stock prices endpoint"""
    background_tasks.add_task(sync_all_stocks, request.symbols, request.days_back)
    return {
        "status": "accepted",
        "message": f"Sync started for {len(request.symbols)} symbols",
    }


@app.post("/sync-now")
async def sync_now(request: SyncRequest):
    """Sync stock prices synchronously (for testing)"""
    total = await sync_all_stocks(request.symbols, request.days_back)
    return {"status": "completed", "records_inserted": total}


@app.post("/sync-all-asx")
async def sync_all_asx(background_tasks: BackgroundTasks, days_back: int = 5):
    """Sync ALL ASX stocks from the official company list"""
    stock_codes = load_all_asx_stocks()

    if not stock_codes:
        return {"status": "error", "message": "Failed to load ASX stock list"}

    background_tasks.add_task(sync_all_stocks, stock_codes, days_back)
    return {
        "status": "accepted",
        "message": f"Sync started for {len(stock_codes)} ASX stocks",
        "stocks_count": len(stock_codes),
        "days_back": days_back,
    }


@app.post("/sync-all-asx-now")
async def sync_all_asx_now(days_back: int = 5):
    """Sync ALL ASX stocks synchronously (for manual triggers)"""
    stock_codes = load_all_asx_stocks()

    if not stock_codes:
        return {"status": "error", "message": "Failed to load ASX stock list"}

    logger.info(f"Starting sync for {len(stock_codes)} ASX stocks")
    total = await sync_all_stocks(stock_codes, days_back)

    return {
        "status": "completed",
        "records_inserted": total,
        "stocks_processed": len(stock_codes),
        "days_back": days_back,
    }


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "Stock Price Sync",
        "endpoints": [
            "/health",
            "/sync",
            "/sync-now",
            "/sync-all-asx",
            "/sync-all-asx-now",
        ],
        "docs": "/docs",
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
