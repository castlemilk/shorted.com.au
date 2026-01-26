#!/usr/bin/env python3
"""
Daily Historical Data Sync Service

This service runs daily to update historical price data for ALL ASX stocks.
Only fetches the last 5 days of data for each stock (incremental update).

Designed to run as:
1. Cloud Run job (scheduled daily via Cloud Scheduler)
2. Kubernetes CronJob
3. Manual execution: python daily_historical_sync.py
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
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Database configuration
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")

# Configuration
DAYS_TO_SYNC = int(os.getenv("SYNC_DAYS", "5"))  # Default: sync last 5 days
BATCH_SIZE = 50  # Process stocks in batches
RATE_LIMIT_DELAY = 0.3  # Seconds between API calls

# Path to ASX company list
# Check if running in Docker (Cloud Run) or locally
if os.path.exists("/app/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv"):
    ASX_LIST_PATH = Path("/app/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv")
else:
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
        logger.info(f"📊 Loaded {len(stock_codes)} ASX stocks from {ASX_LIST_PATH.name}")
        return sorted(stock_codes)
    except Exception as e:
        logger.error(f"❌ Failed to load ASX list: {e}")
        logger.error(f"   Expected file at: {ASX_LIST_PATH}")
        raise


async def get_stocks_needing_update(conn, all_stocks: List[str], days: int) -> List[str]:
    """Get list of stocks that need updating (missing recent data)."""
    cutoff_date = date.today() - timedelta(days=days)
    
    # Find stocks with no data or outdated data
    stocks_needing_update = []
    
    for stock in all_stocks:
        latest = await conn.fetchval(
            "SELECT MAX(date) FROM stock_prices WHERE stock_code = $1",
            stock
        )
        
        if latest is None or latest < cutoff_date:
            stocks_needing_update.append(stock)
    
    logger.info(f"📋 {len(stocks_needing_update)} stocks need updating (out of {len(all_stocks)})")
    return stocks_needing_update


def fetch_recent_price_data(stock_code: str, days: int) -> List[Dict]:
    """Fetch recent price data from Yahoo Finance."""
    yf_ticker = f"{stock_code}.AX"
    
    try:
        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=days + 5)  # Extra buffer
        
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
        logger.debug(f"  ⚠️  {stock_code}: {str(e)[:50]}")
        return []


async def upsert_price_data(conn, data: List[Dict]) -> int:
    """Upsert price data into the database (insert or update)."""
    if not data:
        return 0
    
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
                for d in data
            ],
        )
        return len(data)
    except Exception as e:
        logger.error(f"❌ Error upserting data: {e}")
        return 0


async def sync_stock(conn, stock_code: str, days: int) -> tuple[int, str]:
    """Sync recent data for a single stock."""
    # Fetch recent data
    data = fetch_recent_price_data(stock_code, days)
    
    if not data:
        return 0, "no_data"
    
    # Upsert data
    inserted = await upsert_price_data(conn, data)
    
    return inserted, "success" if inserted > 0 else "failed"


async def sync_batch(conn, stocks: List[str], days: int) -> Dict[str, int]:
    """Sync a batch of stocks."""
    results = {
        "success": 0,
        "no_data": 0,
        "failed": 0,
        "total_records": 0
    }
    
    for stock in stocks:
        try:
            records, status = await sync_stock(conn, stock, days)
            
            if status == "success":
                results["success"] += 1
                results["total_records"] += records
            elif status == "no_data":
                results["no_data"] += 1
            else:
                results["failed"] += 1
                
        except Exception as e:
            logger.error(f"❌ {stock}: {e}")
            results["failed"] += 1
        
        # Rate limiting
        time.sleep(RATE_LIMIT_DELAY)
    
    return results


async def main():
    """Main sync function."""
    logger.info("=" * 70)
    logger.info("🔄 DAILY HISTORICAL DATA SYNC")
    logger.info("=" * 70)
    logger.info(f"📅 Syncing last {DAYS_TO_SYNC} days of data")
    logger.info(f"📊 Rate limit: {RATE_LIMIT_DELAY}s between requests")
    logger.info("")
    
    start_time = time.time()
    
    # Load all ASX stocks
    all_stocks = load_asx_stocks()
    
    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        # Get stocks needing update
        stocks_to_update = await get_stocks_needing_update(conn, all_stocks, DAYS_TO_SYNC)
        
        if not stocks_to_update:
            logger.info("✅ All stocks are up to date!")
            return
        
        logger.info(f"🎯 Processing {len(stocks_to_update)} stocks in batches of {BATCH_SIZE}")
        logger.info("")
        
        # Process in batches
        total_results = {
            "success": 0,
            "no_data": 0,
            "failed": 0,
            "total_records": 0
        }
        
        for i in range(0, len(stocks_to_update), BATCH_SIZE):
            batch = stocks_to_update[i:i + BATCH_SIZE]
            batch_num = i // BATCH_SIZE + 1
            total_batches = (len(stocks_to_update) - 1) // BATCH_SIZE + 1
            
            logger.info(f"📦 Batch {batch_num}/{total_batches}: {batch[0]} to {batch[-1]}")
            
            batch_results = await sync_batch(conn, batch, DAYS_TO_SYNC)
            
            # Aggregate results
            for key in total_results:
                total_results[key] += batch_results[key]
            
            logger.info(f"   ✅ {batch_results['success']} success, "
                       f"⚠️  {batch_results['no_data']} no data, "
                       f"❌ {batch_results['failed']} failed")
            logger.info(f"   📊 {batch_results['total_records']} records updated")
            logger.info("")
        
        # Print summary
        elapsed = time.time() - start_time
        logger.info("=" * 70)
        logger.info("📊 SYNC COMPLETE")
        logger.info("=" * 70)
        logger.info(f"⏱️  Duration: {elapsed:.1f} seconds ({elapsed/60:.1f} minutes)")
        logger.info(f"✅ Success: {total_results['success']}")
        logger.info(f"⚠️  No data: {total_results['no_data']}")
        logger.info(f"❌ Failed: {total_results['failed']}")
        logger.info(f"📊 Total records updated: {total_results['total_records']:,}")
        logger.info("=" * 70)
        
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())

