"""
Enhanced Cloud Run service for ASX market data synchronization.

This service uses the enhanced historical processor with dynamic ASX stock support,
Alpha Vantage API prioritization, and Yahoo Finance fallback.
"""

import asyncio
import asyncpg
import os
import logging
import pandas as pd
from datetime import datetime, date, timedelta
from typing import List, Dict, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from enhanced_historical_processor import EnhancedStockDataProcessor
from enhanced_daily_sync import EnhancedDailySync
from asx_stock_resolver import ASXStockResolver

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")

ALPHA_VANTAGE_API_KEY = os.getenv("ALPHA_VANTAGE_API_KEY", "UOI9AM59F03A0WZC")

# Global variables
db_pool: Optional[asyncpg.Pool] = None
historical_processor: Optional[EnhancedStockDataProcessor] = None
daily_sync: Optional[EnhancedDailySync] = None
stock_resolver: Optional[ASXStockResolver] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    global db_pool, historical_processor, daily_sync, stock_resolver

    logger.info("🚀 Starting Enhanced Market Data Service...")

    # Initialize database connection pool
    logger.info("📊 Connecting to database...")
    db_pool = await asyncpg.create_pool(
        DATABASE_URL, min_size=1, max_size=5, command_timeout=60
    )

    # Initialize enhanced processors
    logger.info("🔧 Initializing enhanced processors...")
    historical_processor = EnhancedStockDataProcessor()
    daily_sync = EnhancedDailySync()
    stock_resolver = ASXStockResolver()

    # Initialize stock resolver with database data
    await stock_resolver.initialize()

    logger.info("✅ Enhanced Market Data Service ready!")
    logger.info(
        f"📈 Available ASX stocks: {len(stock_resolver.get_all_stock_symbols())}"
    )

    yield

    # Cleanup
    logger.info("🛑 Shutting down Enhanced Market Data Service...")
    if db_pool:
        await db_pool.close()


# Create FastAPI app
app = FastAPI(
    title="Enhanced ASX Market Data Service",
    description="Dynamic ASX stock data synchronization with Alpha Vantage prioritization and Yahoo Finance fallback",
    version="4.0.0",
    lifespan=lifespan,
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    """Root endpoint with service information."""
    return {
        "service": "Enhanced ASX Market Data Service",
        "version": "4.0.0",
        "description": "Dynamic ASX stock data synchronization with Alpha Vantage prioritization and Yahoo Finance fallback",
        "features": [
            "Dynamic ASX stock discovery (2000+ stocks)",
            "Alpha Vantage API prioritization",
            "Yahoo Finance fallback",
            "Resilient error handling",
            "Data quality validation",
            "Concurrent processing",
        ],
        "endpoints": {
            "health": "/health",
            "docs": "/docs",
            "sync": "/sync",
            "historical": "/historical",
            "stocks": "/stocks",
            "stock_info": "/stocks/{symbol}",
        },
    }


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    try:
        # Test database connection
        async with db_pool.acquire() as conn:
            await conn.fetchval("SELECT 1")

        # Test stock resolver
        stock_count = len(stock_resolver.get_all_stock_symbols())

        return {
            "status": "healthy",
            "timestamp": datetime.utcnow().isoformat(),
            "database": "connected",
            "asx_stocks_available": stock_count,
            "processors": {
                "historical": "ready",
                "daily_sync": "ready",
                "stock_resolver": "ready",
            },
        }
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        raise HTTPException(status_code=503, detail=f"Service unhealthy: {str(e)}")


@app.post("/sync")
async def sync_market_data(background_tasks: BackgroundTasks):
    """Sync recent market data for all ASX stocks."""
    try:
        logger.info("🔄 Starting market data sync...")

        # Run sync in background
        background_tasks.add_task(run_daily_sync_task)

        return {
            "message": "Market data sync started",
            "timestamp": datetime.utcnow().isoformat(),
            "status": "running",
        }
    except Exception as e:
        logger.error(f"Sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def run_daily_sync_task():
    """Background task for daily sync."""
    try:
        logger.info("🔄 Running daily sync task...")

        async with db_pool.acquire() as conn:
            result = await daily_sync.run_daily_sync(
                days_back=5, limit=50  # Process top 50 stocks for daily sync
            )

        logger.info(f"✅ Daily sync completed: {result}")
    except Exception as e:
        logger.error(f"Daily sync task failed: {e}")


@app.post("/historical")
async def populate_historical_data(
    years: int = 1,
    limit: Optional[int] = None,
    background_tasks: BackgroundTasks = None,
):
    """Populate historical data for ASX stocks."""
    try:
        logger.info(f"📊 Starting historical data population ({years} years)...")

        # Run in background if requested
        if background_tasks:
            background_tasks.add_task(run_historical_task, years, limit)
            return {
                "message": f"Historical data population started ({years} years)",
                "timestamp": datetime.utcnow().isoformat(),
                "status": "running",
            }
        else:
            # Run synchronously
            async with db_pool.acquire() as conn:
                result = await historical_processor.populate_all_stocks(
                    years=years, limit=limit
                )

            return {
                "message": "Historical data population completed",
                "timestamp": datetime.utcnow().isoformat(),
                "result": result,
            }
    except Exception as e:
        logger.error(f"Historical data population failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def run_historical_task(years: int, limit: Optional[int]):
    """Background task for historical data population."""
    try:
        logger.info(f"📊 Running historical data task ({years} years)...")

        async with db_pool.acquire() as conn:
            result = await historical_processor.populate_all_stocks(
                years=years, limit=limit
            )

        logger.info(f"✅ Historical data task completed: {result}")
    except Exception as e:
        logger.error(f"Historical data task failed: {e}")


@app.get("/stocks")
async def get_available_stocks(
    limit: Optional[int] = None,
    industry: Optional[str] = None,
    top_by_market_cap: Optional[int] = None,
):
    """Get available ASX stocks."""
    try:
        if top_by_market_cap:
            stocks = stock_resolver.get_top_stocks_by_market_cap(top_by_market_cap)
        elif industry:
            stocks = stock_resolver.get_symbols_by_industry(industry)
        else:
            stocks = list(stock_resolver.get_all_stock_symbols())

        if limit:
            stocks = stocks[:limit]

        return {
            "stocks": stocks,
            "count": len(stocks),
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as e:
        logger.error(f"Failed to get stocks: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stocks/{symbol}")
async def get_stock_info(symbol: str):
    """Get detailed information for a specific stock."""
    try:
        # Validate symbol
        if not stock_resolver.is_valid_asx_symbol(symbol):
            raise HTTPException(status_code=400, detail=f"Invalid ASX symbol: {symbol}")

        # Get stock info
        stock_info = stock_resolver.get_stock_info(symbol)
        if not stock_info:
            raise HTTPException(status_code=404, detail=f"Stock not found: {symbol}")

        # Get provider symbols
        alpha_symbol, yahoo_symbol = stock_resolver.resolve_symbols_for_providers(
            symbol
        )

        return {
            "symbol": symbol,
            "info": stock_info,
            "provider_symbols": {
                "alpha_vantage": alpha_symbol,
                "yahoo_finance": yahoo_symbol,
            },
            "timestamp": datetime.utcnow().isoformat(),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get stock info for {symbol}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stocks/{symbol}/data")
async def get_stock_data(symbol: str, years: int = 1):
    """Get historical data for a specific stock."""
    try:
        # Validate symbol
        if not stock_resolver.is_valid_asx_symbol(symbol):
            raise HTTPException(status_code=400, detail=f"Invalid ASX symbol: {symbol}")

        # Fetch data
        df = await historical_processor.fetch_stock_data_with_fallback(
            symbol, years=years
        )

        if df is None or df.empty:
            raise HTTPException(
                status_code=404, detail=f"No data available for {symbol}"
            )

        # Convert to records
        records = historical_processor.convert_dataframe_to_records(df, symbol)

        return {
            "symbol": symbol,
            "data": records,
            "count": len(records),
            "date_range": {
                "start": records[0]["date"].isoformat() if records else None,
                "end": records[-1]["date"].isoformat() if records else None,
            },
            "timestamp": datetime.utcnow().isoformat(),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get stock data for {symbol}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stats")
async def get_service_stats():
    """Get service statistics."""
    try:
        async with db_pool.acquire() as conn:
            # Get total records count
            total_records = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")

            # Get stocks with data
            stocks_with_data = await conn.fetch(
                """
                SELECT stock_code, COUNT(*) as records, 
                       MIN(date) as earliest, MAX(date) as latest
                FROM stock_prices 
                GROUP BY stock_code 
                ORDER BY records DESC 
                LIMIT 10
            """
            )

        return {
            "total_records": total_records,
            "top_stocks": [
                {
                    "symbol": row["stock_code"],
                    "records": row["records"],
                    "earliest": (
                        row["earliest"].isoformat() if row["earliest"] else None
                    ),
                    "latest": row["latest"].isoformat() if row["latest"] else None,
                }
                for row in stocks_with_data
            ],
            "available_stocks": len(stock_resolver.get_all_stock_symbols()),
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as e:
        logger.error(f"Failed to get stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
