#!/usr/bin/env python3
"""
Comprehensive Daily Sync Service

This service runs daily to update:
1. Shorts position data from ASIC
2. Stock price data with Alpha Vantage (priority) + Yahoo Finance (fallback)

Designed to run as a Cloud Run Job scheduled daily.
"""
import asyncio
import asyncpg
from datetime import date, timedelta
import yfinance as yf
import pandas as pd
import httpx
import aiohttp
import time
import os
from pathlib import Path
import logging
from typing import List, Dict, Set, Optional

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

# Alpha Vantage configuration (optional - falls back to Yahoo if not provided)
ALPHA_VANTAGE_API_KEY = os.getenv("ALPHA_VANTAGE_API_KEY")

# Configuration
SYNC_DAYS_STOCK_PRICES = int(os.getenv("SYNC_DAYS_STOCK_PRICES", "5"))
SYNC_DAYS_SHORTS = int(os.getenv("SYNC_DAYS_SHORTS", "7"))  # Get last week of shorts data
ALPHA_VANTAGE_DELAY = 12.0  # Alpha Vantage rate limit: 5 calls/minute
YAHOO_FINANCE_DELAY = 0.3  # Yahoo Finance rate limit: more lenient

# ASIC Data URLs
ASIC_DATA_URL = "https://download.asic.gov.au/short-selling/short-selling-data.json"
ASIC_BASE_URL = "https://download.asic.gov.au/short-selling/"


def generate_download_url(record: Dict) -> str:
    """Generate download URL for ASIC shorts data."""
    date_str = str(record["date"])
    year, month, day = date_str[:4], date_str[4:6], date_str[6:]
    return f"{ASIC_BASE_URL}RR{year}{month}{day}-{record['version']}-SSDailyAggShortPos.csv"


async def get_recent_shorts_files(days: int = 7) -> List[str]:
    """Get URLs for recent shorts data files from ASIC."""
    logger.info(f"📥 Fetching list of ASIC shorts files (last {days} days)...")
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(ASIC_DATA_URL)
            all_records = response.json()
        
        # Filter for recent dates
        cutoff_date = int((date.today() - timedelta(days=days)).strftime("%Y%m%d"))
        recent_records = [r for r in all_records if r["date"] >= cutoff_date]
        
        urls = [generate_download_url(r) for r in recent_records]
        logger.info(f"📊 Found {len(urls)} recent shorts data files")
        return urls
        
    except Exception as e:
        logger.error(f"❌ Failed to fetch ASIC file list: {e}")
        return []


async def download_and_parse_shorts_csv(url: str) -> pd.DataFrame:
    """Download and parse a single shorts CSV file."""
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(url)
            response.raise_for_status()
        
        # Extract date from filename
        filename = url.split("/")[-1]
        date_str = "".join(filter(str.isdigit, filename.split("-")[0]))
        
        # Parse CSV
        from io import StringIO
        df = pd.read_csv(StringIO(response.text))
        
        # Normalize column names
        df.columns = (
            df.columns.str.upper()
            .str.strip()
            .str.replace(" ", "_")
            .str.replace("%", "PERCENT")
        )
        
        # Add date
        df["DATE"] = pd.to_datetime(date_str, format="%Y%m%d")
        
        # Clean data
        df["PRODUCT_CODE"] = df["PRODUCT_CODE"].str.strip()
        df["PRODUCT"] = df["PRODUCT"].str.strip()
        
        return df
        
    except Exception as e:
        logger.warning(f"⚠️  Failed to download {url}: {str(e)[:100]}")
        return pd.DataFrame()


async def update_shorts_data(conn, days: int = 7):
    """Update shorts position data from ASIC."""
    logger.info("\n" + "="*60)
    logger.info("📊 UPDATING SHORTS DATA")
    logger.info("="*60)
    
    # Get recent files
    urls = await get_recent_shorts_files(days)
    
    if not urls:
        logger.warning("⚠️  No shorts data files to process")
        return 0
    
    total_inserted = 0
    
    for i, url in enumerate(urls, 1):
        logger.info(f"[{i}/{len(urls)}] Processing {url.split('/')[-1]}")
        
        df = await download_and_parse_shorts_csv(url)
        
        if df.empty:
            continue
        
        # Insert into database (upsert)
        try:
            records = df.to_records(index=False)
            inserted = 0
            
            for record in records:
                try:
                    await conn.execute(
                        '''
                        INSERT INTO shorts (
                            "DATE", "PRODUCT", "PRODUCT_CODE",
                            "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE",
                            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
                        )
                        VALUES ($1, $2, $3, $4, $5, $6)
                        ON CONFLICT ("DATE", "PRODUCT_CODE") DO UPDATE SET
                            "REPORTED_SHORT_POSITIONS" = EXCLUDED."REPORTED_SHORT_POSITIONS",
                            "TOTAL_PRODUCT_IN_ISSUE" = EXCLUDED."TOTAL_PRODUCT_IN_ISSUE",
                            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" = 
                                EXCLUDED."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
                        ''',
                        record['DATE'].date(),
                        str(record['PRODUCT']),
                        str(record['PRODUCT_CODE']),
                        float(record.get('REPORTED_SHORT_POSITIONS', 0) or 0),
                        float(record.get('TOTAL_PRODUCT_IN_ISSUE', 0) or 0),
                        float(record.get('PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS', 0) or 0)
                    )
                    inserted += 1
                except Exception as e:
                    # Skip individual record errors
                    continue
            
            total_inserted += inserted
            logger.info(f"  ✅ Inserted/Updated {inserted} records")
            
        except Exception as e:
            logger.error(f"  ❌ Error: {str(e)[:100]}")
    
    logger.info(f"\n✅ Shorts update complete: {total_inserted} total records updated")
    return total_inserted


async def get_stocks_with_price_data(conn) -> List[str]:
    """Get list of stocks that already have price data."""
    stocks = await conn.fetch("SELECT DISTINCT stock_code FROM stock_prices ORDER BY stock_code")
    stock_list = [row["stock_code"] for row in stocks]
    logger.info(f"📋 Found {len(stock_list)} stocks with existing price data")
    return stock_list


async def fetch_from_alpha_vantage(stock_code: str, days: int, session: aiohttp.ClientSession) -> Optional[List[Dict]]:
    """Fetch recent price data from Alpha Vantage API."""
    if not ALPHA_VANTAGE_API_KEY:
        return None
    
    try:
        # Alpha Vantage uses stock code without .AX
        params = {
            'function': 'TIME_SERIES_DAILY',
            'symbol': f'{stock_code}.AX',  # Alpha Vantage supports .AX suffix
            'apikey': ALPHA_VANTAGE_API_KEY,
            'outputsize': 'compact'  # Last 100 days
        }
        
        async with session.get('https://www.alphavantage.co/query', params=params) as response:
            if response.status == 429:
                logger.warning(f"  ⚠️  Alpha Vantage rate limit hit")
                return None
            
            if response.status != 200:
                return None
            
            result = await response.json()
            
            # Check for errors
            if 'Error Message' in result or 'Note' in result or 'Information' in result:
                return None
            
            time_series = result.get('Time Series (Daily)', {})
            if not time_series:
                return None
            
            # Convert to our format
            cutoff_date = date.today() - timedelta(days=days + 5)
            data = []
            
            for date_str, values in time_series.items():
                trade_date = pd.to_datetime(date_str).date()
                if trade_date < cutoff_date:
                    continue
                
                data.append({
                    "stock_code": stock_code,
                    "date": trade_date,
                    "open": round(float(values['1. open']), 2),
                    "high": round(float(values['2. high']), 2),
                    "low": round(float(values['3. low']), 2),
                    "close": round(float(values['4. close']), 2),
                    "adjusted_close": round(float(values['4. close']), 2),
                    "volume": int(float(values['5. volume'])),
                })
            
            return data if data else None
            
    except Exception as e:
        logger.debug(f"  Alpha Vantage error: {str(e)[:50]}")
        return None


def fetch_from_yahoo_finance(stock_code: str, days: int) -> Optional[List[Dict]]:
    """Fetch recent price data from Yahoo Finance (fallback)."""
    yf_ticker = f"{stock_code}.AX"
    
    try:
        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=days + 5)  # Extra buffer
        
        hist = ticker.history(start=start_date, end=end_date, interval="1d")
        
        if hist.empty:
            return None
        
        # Convert to our format
        data = []
        for date_idx, row in hist.iterrows():
            if pd.isna(row["Open"]) or pd.isna(row["Close"]):
                continue
            
            data.append({
                "stock_code": stock_code,
                "date": date_idx.date(),
                "open": round(float(row["Open"]), 2),
                "high": round(float(row["High"]), 2),
                "low": round(float(row["Low"]), 2),
                "close": round(float(row["Close"]), 2),
                "adjusted_close": round(float(row["Close"]), 2),
                "volume": int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
            })
        
        return data if data else None
        
    except Exception as e:
        logger.debug(f"  Yahoo Finance error: {str(e)[:50]}")
        return None


async def fetch_recent_price_data_with_fallback(
    stock_code: str, 
    days: int, 
    session: aiohttp.ClientSession
) -> tuple[Optional[List[Dict]], str]:
    """
    Fetch recent price data with Alpha Vantage priority and Yahoo Finance fallback.
    
    Returns:
        tuple: (data, source) where source is 'alpha_vantage', 'yahoo_finance', or 'failed'
    """
    # Try Alpha Vantage first (if API key is configured)
    if ALPHA_VANTAGE_API_KEY:
        data = await fetch_from_alpha_vantage(stock_code, days, session)
        if data:
            return data, "alpha_vantage"
    
    # Fallback to Yahoo Finance
    data = fetch_from_yahoo_finance(stock_code, days)
    if data:
        return data, "yahoo_finance"
    
    return None, "failed"


async def insert_price_data(conn, data: List[Dict]) -> int:
    """Insert stock price data into database (upsert)."""
    if not data:
        return 0
    
    try:
        inserted = 0
        for d in data:
            try:
                await conn.execute(
                    '''
                    INSERT INTO stock_prices (
                        stock_code, date, open, high, low, close, adjusted_close, volume
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (stock_code, date) DO UPDATE SET
                        open = EXCLUDED.open,
                        high = EXCLUDED.high,
                        low = EXCLUDED.low,
                        close = EXCLUDED.close,
                        adjusted_close = EXCLUDED.adjusted_close,
                        volume = EXCLUDED.volume,
                        updated_at = CURRENT_TIMESTAMP
                    ''',
                    d["stock_code"], d["date"], d["open"], d["high"],
                    d["low"], d["close"], d["adjusted_close"], d["volume"]
                )
                inserted += 1
            except Exception:
                continue
        
        return inserted
        
    except Exception:
        return 0


async def update_stock_prices(conn, days: int = 5):
    """Update stock price data with Alpha Vantage priority and Yahoo Finance fallback."""
    logger.info("\n" + "="*60)
    logger.info("💰 UPDATING STOCK PRICES")
    logger.info("="*60)
    
    # Get stocks that already have price data
    stocks = await get_stocks_with_price_data(conn)
    
    if not stocks:
        logger.warning("⚠️  No stocks with existing price data")
        return 0
    
    # Check if Alpha Vantage is configured
    if ALPHA_VANTAGE_API_KEY:
        logger.info(f"🔑 Alpha Vantage API key detected - will use as primary source")
        logger.info(f"🔄 Yahoo Finance configured as fallback")
    else:
        logger.info(f"⚠️  No Alpha Vantage API key - using Yahoo Finance only")
    
    logger.info(f"🔄 Updating {len(stocks)} stocks with last {days} days of data\n")
    
    total_inserted = 0
    successful = 0
    failed = 0
    alpha_vantage_count = 0
    yahoo_finance_count = 0
    
    # Create aiohttp session for Alpha Vantage
    async with aiohttp.ClientSession() as session:
        for i, stock_code in enumerate(stocks, 1):
            # Fetch data with fallback
            data, source = await fetch_recent_price_data_with_fallback(stock_code, days, session)
            
            if not data:
                logger.info(f"[{i:3d}/{len(stocks)}] {stock_code}: ⚠️  No data from any source")
                failed += 1
                # Use appropriate delay based on last attempt
                await asyncio.sleep(YAHOO_FINANCE_DELAY)
                continue
            
            # Insert data
            inserted = await insert_price_data(conn, data)
            
            if inserted > 0:
                source_emoji = "🔑" if source == "alpha_vantage" else "🌐"
                source_name = "Alpha Vantage" if source == "alpha_vantage" else "Yahoo Finance"
                logger.info(f"[{i:3d}/{len(stocks)}] {stock_code}: ✅ {inserted} records ({source_emoji} {source_name})")
                total_inserted += inserted
                successful += 1
                
                if source == "alpha_vantage":
                    alpha_vantage_count += 1
                else:
                    yahoo_finance_count += 1
            else:
                logger.info(f"[{i:3d}/{len(stocks)}] {stock_code}: ❌ Insert failed")
                failed += 1
            
            # Rate limiting based on source
            if source == "alpha_vantage":
                await asyncio.sleep(ALPHA_VANTAGE_DELAY)  # 12 seconds for Alpha Vantage
            else:
                await asyncio.sleep(YAHOO_FINANCE_DELAY)  # 0.3 seconds for Yahoo
    
    logger.info(f"\n✅ Stock prices update complete:")
    logger.info(f"   Successful: {successful}")
    logger.info(f"   Failed: {failed}")
    if ALPHA_VANTAGE_API_KEY:
        logger.info(f"   🔑 Alpha Vantage: {alpha_vantage_count}")
        logger.info(f"   🌐 Yahoo Finance: {yahoo_finance_count}")
    logger.info(f"   Total records: {total_inserted}")
    
    return total_inserted


async def main():
    """Main sync function."""
    logger.info("🚀 COMPREHENSIVE DAILY SYNC - STARTING")
    logger.info("="*60)
    logger.info(f"⏰ Started at: {date.today()}")
    logger.info(f"📊 Shorts sync: Last {SYNC_DAYS_SHORTS} days")
    logger.info(f"💰 Stock prices sync: Last {SYNC_DAYS_STOCK_PRICES} days")
    logger.info("="*60)
    
    start_time = time.time()
    
    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        # Update shorts data
        shorts_updated = await update_shorts_data(conn, SYNC_DAYS_SHORTS)
        
        # Update stock prices
        prices_updated = await update_stock_prices(conn, SYNC_DAYS_STOCK_PRICES)
        
        # Final summary
        duration = time.time() - start_time
        logger.info("\n" + "="*60)
        logger.info("🎉 SYNC COMPLETE")
        logger.info("="*60)
        logger.info(f"📊 Shorts records updated: {shorts_updated:,}")
        logger.info(f"💰 Price records updated: {prices_updated:,}")
        logger.info(f"⏱️  Duration: {duration:.1f} seconds")
        logger.info("="*60)
        
    except Exception as e:
        logger.error(f"\n❌ SYNC FAILED: {e}")
        raise
    
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())

