"""
Cloud Run service for market data synchronization using pluggable data providers.

This service provides a FastAPI application that can sync stock data using different
data providers (Alpha Vantage, Yahoo Finance, etc.) in a pluggable architecture.
"""

import asyncio
import asyncpg
import os
import logging
import pandas as pd
from datetime import datetime, date, timedelta
from typing import List, Dict, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from data_providers.factory import DataProviderFactory
from data_providers.base import StockDataProvider

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")

# Data provider configuration
DATA_PROVIDER = os.getenv("DATA_PROVIDER", "alpha_vantage")  # Default to Alpha Vantage
ALPHA_VANTAGE_API_KEY = os.getenv("ALPHA_VANTAGE_API_KEY", "UOI9AM59F03A0WZC")

# Rate limiting configuration
BATCH_SIZE = 10  # Process stocks in batches
BATCH_DELAY = 2  # Delay between batches

# Global variables
db_pool: Optional[asyncpg.Pool] = None
data_provider: Optional[StockDataProvider] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    global db_pool, data_provider
    
    # Initialize database connection pool
    logger.info("Initializing database connection pool...")
    db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=10)
    
    # Initialize data provider
    logger.info(f"Initializing data provider: {DATA_PROVIDER}")
    try:
        if DATA_PROVIDER == "alpha_vantage":
            data_provider = DataProviderFactory.create_provider(
                DATA_PROVIDER, 
                api_key=ALPHA_VANTAGE_API_KEY
            )
        else:
            data_provider = DataProviderFactory.create_provider(DATA_PROVIDER)
        
        logger.info(f"Data provider initialized: {data_provider.get_provider_name()}")
    except Exception as e:
        logger.error(f"Failed to initialize data provider: {e}")
        raise
    
    yield
    
    # Cleanup
    logger.info("Cleaning up resources...")
    if db_pool:
        await db_pool.close()
    if data_provider and hasattr(data_provider, 'session'):
        await data_provider.__aexit__(None, None, None)


# Create FastAPI app
app = FastAPI(
    title="Market Data Sync Service",
    description="Service for syncing stock market data using pluggable data providers",
    version="2.0.0",
    lifespan=lifespan
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://*.vercel.app",
        "https://*.shorted.com.au",
        "http://localhost:3000",
        "http://localhost:8080"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def get_all_stock_codes() -> List[str]:
    """Get all stock codes from the database."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("SELECT DISTINCT stock_code FROM stock_prices ORDER BY stock_code")
        return [row['stock_code'] for row in rows]


async def insert_stock_data(stock_code: str, df, conn: asyncpg.Connection):
    """Insert stock data into the database."""
    records = []
    
    for date_idx, row in df.iterrows():
        records.append({
            'stock_code': stock_code,
            'date': date_idx.date(),
            'open': float(row['Open']),
            'high': float(row['High']),
            'low': float(row['Low']),
            'close': float(row['Close']),
            'volume': int(row['Volume']) if pd.notna(row['Volume']) else 0,
            'adjusted_close': float(row['Close'])  # Using close as adjusted_close for simplicity
        })

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
            [(r['stock_code'], r['date'], r['open'], r['high'], r['low'], r['close'], r['volume'], r['adjusted_close']) for r in records]
        )
        logger.info(f"Inserted {len(records)} records for {stock_code}")


async def sync_batch(stock_codes: List[str], start_date: Optional[date] = None) -> Dict[str, int]:
    """Sync a batch of stock codes."""
    results = {"success": 0, "failed": 0, "total_records": 0}
    
    logger.info(f"Syncing batch of {len(stock_codes)} stocks using {data_provider.get_provider_name()}")
    
    # Use async context manager for data provider
    async with data_provider as provider:
        # Fetch data for all symbols in the batch
        stock_data = await provider.fetch_multiple_symbols(stock_codes, start_date=start_date)
        
        # Insert data into database
        async with db_pool.acquire() as conn:
            for stock_code, df in stock_data.items():
                try:
                    await insert_stock_data(stock_code, df, conn)
                    results["success"] += 1
                    results["total_records"] += len(df)
                    logger.info(f"Successfully synced {stock_code}: {len(df)} records")
                except Exception as e:
                    logger.error(f"Failed to insert data for {stock_code}: {e}")
                    results["failed"] += 1
    
    return results


async def main_sync_logic(start_date: Optional[date] = None) -> Dict[str, int]:
    """Main synchronization logic."""
    logger.info(f"Starting market data sync using {data_provider.get_provider_name()}")
    logger.info(f"Provider rate limit delay: {data_provider.get_rate_limit_delay()}s")
    logger.info(f"Provider batch size: {data_provider.get_batch_size()}")
    
    # Get all stock codes
    stock_codes = await get_all_stock_codes()
    logger.info(f"Found {len(stock_codes)} stocks to sync")
    
    if not stock_codes:
        logger.warning("No stocks found in database")
        return {"success": 0, "failed": 0, "total_records": 0}
    
    # Process stocks in batches
    batch_size = data_provider.get_batch_size()
    total_results = {"success": 0, "failed": 0, "total_records": 0}
    
    for i in range(0, len(stock_codes), batch_size):
        batch = stock_codes[i:i + batch_size]
        batch_num = i // batch_size + 1
        total_batches = (len(stock_codes) + batch_size - 1) // batch_size
        
        logger.info(f"Processing batch {batch_num}/{total_batches} ({len(batch)} stocks)")
        
        try:
            batch_results = await sync_batch(batch, start_date)
            
            # Accumulate results
            for key in total_results:
                total_results[key] += batch_results[key]
            
            logger.info(f"Batch {batch_num} completed: {batch_results['success']} success, {batch_results['failed']} failed")
            
            # Delay between batches
            if i + batch_size < len(stock_codes):
                delay = BATCH_DELAY
                logger.info(f"Waiting {delay}s before next batch...")
                await asyncio.sleep(delay)
                
        except Exception as e:
            logger.error(f"Batch {batch_num} failed: {e}")
            total_results["failed"] += len(batch)
    
    logger.info(f"Sync completed: {total_results['success']} stocks successful, {total_results['failed']} failed")
    logger.info(f"Total records processed: {total_results['total_records']}")
    
    return total_results


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "provider": data_provider.get_provider_name() if data_provider else "unknown",
        "database_connected": db_pool is not None
    }


@app.post("/sync")
async def trigger_sync():
    """Trigger market data synchronization."""
    try:
        logger.info("Manual sync triggered")
        
        # Sync only recent data (last 7 days)
        start_date = date.today() - timedelta(days=7)
        
        results = await main_sync_logic(start_date=start_date)
        
        return {
            "status": "completed",
            "timestamp": datetime.utcnow().isoformat(),
            "provider": data_provider.get_provider_name(),
            "results": results
        }
        
    except Exception as e:
        logger.error(f"Sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sync-full")
async def trigger_full_sync():
    """Trigger full historical data synchronization."""
    try:
        logger.info("Full sync triggered")
        
        results = await main_sync_logic(start_date=None)
        
        return {
            "status": "completed",
            "timestamp": datetime.utcnow().isoformat(),
            "provider": data_provider.get_provider_name(),
            "results": results
        }
        
    except Exception as e:
        logger.error(f"Full sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/provider-info")
async def get_provider_info():
    """Get information about the current data provider."""
    if not data_provider:
        raise HTTPException(status_code=500, detail="Data provider not initialized")
    
    return {
        "provider_name": data_provider.get_provider_name(),
        "rate_limit_delay": data_provider.get_rate_limit_delay(),
        "batch_size": data_provider.get_batch_size(),
        "available_providers": DataProviderFactory.get_available_providers()
    }


if __name__ == "__main__":
    uvicorn.run(
        "cloud_run_service_v3:app",
        host="0.0.0.0",
        port=8080,
        log_level="info"
    )
