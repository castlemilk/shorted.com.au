#!/usr/bin/env python3
"""
Comprehensive Daily Sync Service with Alpha Vantage Priority

This service runs daily to update:
1. Shorts position data from ASIC
2. Stock price data from Alpha Vantage (primary) with Yahoo Finance fallback

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
from urllib.parse import urlparse, parse_qs, unquote

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

# Alpha Vantage configuration
ALPHA_VANTAGE_API_KEY = os.getenv("ALPHA_VANTAGE_API_KEY")
ALPHA_VANTAGE_ENABLED = bool(ALPHA_VANTAGE_API_KEY)

# Configuration
SYNC_DAYS_STOCK_PRICES = int(os.getenv("SYNC_DAYS_STOCK_PRICES", "5"))
SYNC_DAYS_SHORTS = int(os.getenv("SYNC_DAYS_SHORTS", "7"))
RATE_LIMIT_DELAY_ALPHA = 12.0  # Alpha Vantage: 5 calls/minute
RATE_LIMIT_DELAY_YAHOO = 0.3   # Yahoo Finance: more lenient

# ASIC Data URLs
ASIC_DATA_URL = "https://download.asic.gov.au/short-selling/short-selling-data.json"
ASIC_BASE_URL = "https://download.asic.gov.au/short-selling/"


# ============================================================================
# SHORTS DATA SYNC
# ============================================================================

def generate_download_url(record: Dict) -> str:
    """Generate download URL for ASIC shorts data."""
    date_str = str(record["date"])
    year, month, day = date_str[:4], date_str[4:6], date_str[6:]
    return f"{ASIC_BASE_URL}RR{year}{month}{day}-{record['version']}-SSDailyAggShortPos.csv"


async def get_last_shorts_date(conn) -> Optional[date]:
    """Get the most recent date in the shorts table."""
    result = await conn.fetchrow('SELECT MAX("DATE") as last_date FROM shorts')
    if result and result["last_date"]:
        # Convert datetime to date if needed
        last_date = result["last_date"]
        return last_date.date() if hasattr(last_date, 'date') else last_date
    return None


async def get_recent_shorts_files(days: int = 7, since_date: Optional[date] = None) -> List[str]:
    """Get URLs for recent shorts data files from ASIC.
    
    Args:
        days: Default number of days to look back if since_date is None
        since_date: If provided, fetch files from this date onwards
    """
    if since_date:
        logger.info(f"📥 Fetching ASIC shorts files from {since_date} onwards...")
        cutoff_date = int(since_date.strftime("%Y%m%d"))
    else:
        logger.info(f"📥 Fetching list of ASIC shorts files (last {days} days)...")
        cutoff_date = int((date.today() - timedelta(days=days)).strftime("%Y%m%d"))
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(ASIC_DATA_URL)
            all_records = response.json()
        
        recent_records = [r for r in all_records if r["date"] >= cutoff_date]
        
        urls = [generate_download_url(r) for r in recent_records]
        logger.info(f"📊 Found {len(urls)} shorts data files to process")
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
        
        filename = url.split("/")[-1]
        date_str = "".join(filter(str.isdigit, filename.split("-")[0]))
        
        from io import StringIO
        df = pd.read_csv(StringIO(response.text))
        
        df.columns = (
            df.columns.str.upper()
            .str.strip()
            .str.replace(" ", "_")
            .str.replace("%", "PERCENT")
        )
        
        df["DATE"] = pd.to_datetime(date_str, format="%Y%m%d")
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
    
    # Check last ingested date
    last_date = await get_last_shorts_date(conn)
    if last_date:
        logger.info(f"   Last ingested shorts date: {last_date}")
        # If we have data from today, skip
        if last_date >= date.today():
            logger.info(f"   ✓ Already up to date!")
            return 0
        # Fetch from last date onwards
        urls = await get_recent_shorts_files(days=days, since_date=last_date + timedelta(days=1))
    else:
        logger.info(f"   No existing shorts data - initial load")
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
                except Exception:
                    continue
            
            total_inserted += inserted
            logger.info(f"  ✅ Inserted/Updated {inserted} records")
            
        except Exception as e:
            logger.error(f"  ❌ Error: {str(e)[:100]}")
    
    logger.info(f"\n✅ Shorts update complete: {total_inserted} total records updated")
    return total_inserted


# ============================================================================
# STOCK PRICE SYNC WITH ALPHA VANTAGE + YAHOO FALLBACK
# ============================================================================

async def fetch_from_alpha_vantage(session: aiohttp.ClientSession, stock_code: str, days: int) -> Optional[List[Dict]]:
    """Fetch recent price data from Alpha Vantage."""
    if not ALPHA_VANTAGE_API_KEY:
        return None
    
    try:
        # Alpha Vantage uses plain stock codes for ASX (strip .AX suffix if present)
        symbol = stock_code.replace('.AX', '')
        
        params = {
            'function': 'TIME_SERIES_DAILY',
            'symbol': symbol,
            'apikey': ALPHA_VANTAGE_API_KEY,
            'outputsize': 'compact'  # Last 100 days
        }
        
        async with session.get('https://www.alphavantage.co/query', params=params) as response:
            if response.status == 429:
                logger.warning(f"  ⚠️  Alpha Vantage rate limit hit")
                return None
            
            if response.status != 200:
                return None
            
            data = await response.json()
            
            # Check for errors
            if 'Error Message' in data or 'Note' in data or 'Information' in data:
                return None
            
            time_series = data.get('Time Series (Daily)', {})
            if not time_series:
                return None
            
            # Convert to our format
            cutoff_date = date.today() - timedelta(days=days + 5)
            result = []
            
            for date_str, values in time_series.items():
                price_date = date.fromisoformat(date_str)
                if price_date < cutoff_date:
                    continue
                
                result.append({
                    'stock_code': stock_code,
                    'date': price_date,
                    'open': round(float(values['1. open']), 2),
                    'high': round(float(values['2. high']), 2),
                    'low': round(float(values['3. low']), 2),
                    'close': round(float(values['4. close']), 2),
                    'adjusted_close': round(float(values['4. close']), 2),
                    'volume': int(values['5. volume'])
                })
            
            return result if result else None
            
    except Exception as e:
        logger.debug(f"  Alpha Vantage error: {str(e)[:50]}")
        return None


def fetch_from_yahoo_finance(stock_code: str, days: int) -> Optional[List[Dict]]:
    """Fetch recent price data from Yahoo Finance (fallback)."""
    # Add .AX suffix only if not already present
    yf_ticker = stock_code if stock_code.endswith('.AX') else f"{stock_code}.AX"
    
    try:
        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=days + 5)
        
        hist = ticker.history(start=start_date, end=end_date, interval="1d")
        
        if hist.empty:
            return None
        
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
        
    except Exception:
        return None


async def get_stocks_with_price_data(conn) -> List[str]:
    """Get list of stocks that already have price data."""
    stocks = await conn.fetch("SELECT DISTINCT stock_code FROM stock_prices ORDER BY stock_code")
    stock_list = [row["stock_code"] for row in stocks]
    logger.info(f"📋 Found {len(stock_list)} stocks with existing price data")
    return stock_list


async def get_last_ingested_date(conn, stock_code: str) -> Optional[date]:
    """Get the most recent date with price data for a given stock."""
    result = await conn.fetchrow(
        "SELECT MAX(date) as last_date FROM stock_prices WHERE stock_code = $1",
        stock_code
    )
    if result and result["last_date"]:
        # Convert datetime to date if needed
        last_date = result["last_date"]
        return last_date.date() if hasattr(last_date, 'date') else last_date
    return None


def calculate_days_to_fetch(last_date: Optional[date], max_days: int = 365) -> int:
    """Calculate how many days of data to fetch based on last ingested date."""
    if not last_date:
        # No data yet, fetch default period
        return max_days
    
    days_missing = (date.today() - last_date).days
    
    # Add 5 extra days for overlap to ensure no gaps
    return min(days_missing + 5, max_days)


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
    """Update stock price data with Alpha Vantage primary, Yahoo Finance fallback."""
    logger.info("\n" + "="*60)
    logger.info("💰 UPDATING STOCK PRICES")
    logger.info("="*60)
    
    if ALPHA_VANTAGE_ENABLED:
        logger.info("🔑 Alpha Vantage API key found - using as primary source")
        logger.info("📊 Yahoo Finance enabled as fallback")
    else:
        logger.info("⚠️  No Alpha Vantage API key - using Yahoo Finance only")
    
    stocks = await get_stocks_with_price_data(conn)
    
    if not stocks:
        logger.warning("⚠️  No stocks with existing price data")
        return 0
    
    logger.info(f"🔄 Updating {len(stocks)} stocks (from last ingested date to today)\n")
    
    total_inserted = 0
    alpha_success = 0
    yahoo_success = 0
    failed = 0
    skipped = 0
    
    # Create aiohttp session for Alpha Vantage
    session = aiohttp.ClientSession() if ALPHA_VANTAGE_ENABLED else None
    
    try:
        for i, stock_code in enumerate(stocks, 1):
            # Check last ingested date for this stock
            last_date = await get_last_ingested_date(conn, stock_code)
            days_to_fetch = calculate_days_to_fetch(last_date, max_days=days)
            
            # Skip if we already have today's data
            if last_date and last_date >= date.today():
                logger.info(f"[{i:3d}/{len(stocks)}] {stock_code}: ✓ Already up to date (last: {last_date})")
                skipped += 1
                continue
            
            data = None
            source = None
            
            # Try Alpha Vantage first
            if ALPHA_VANTAGE_ENABLED and session:
                data = await fetch_from_alpha_vantage(session, stock_code, days_to_fetch)
                if data:
                    source = "Alpha Vantage"
                    alpha_success += 1
                    # Respect Alpha Vantage rate limits
                    await asyncio.sleep(RATE_LIMIT_DELAY_ALPHA)
            
            # Fallback to Yahoo Finance
            if not data:
                data = fetch_from_yahoo_finance(stock_code, days_to_fetch)
                if data:
                    source = "Yahoo Finance"
                    yahoo_success += 1
                    time.sleep(RATE_LIMIT_DELAY_YAHOO)
            
            if not data:
                last_info = f"last: {last_date}" if last_date else "no data yet"
                logger.info(f"[{i:3d}/{len(stocks)}] {stock_code}: ⚠️  No data from any source ({last_info})")
                failed += 1
                continue
            
            # Insert data
            inserted = await insert_price_data(conn, data)
            
            if inserted > 0:
                last_info = f"from {last_date}" if last_date else "initial load"
                logger.info(f"[{i:3d}/{len(stocks)}] {stock_code}: ✅ {inserted} records ({source}, {last_info})")
                total_inserted += inserted
            else:
                logger.info(f"[{i:3d}/{len(stocks)}] {stock_code}: ❌ Insert failed")
                failed += 1
    
    finally:
        if session:
            await session.close()
    
    logger.info(f"\n✅ Stock prices update complete:")
    logger.info(f"   Alpha Vantage: {alpha_success}")
    logger.info(f"   Yahoo Finance: {yahoo_success}")
    logger.info(f"   Already up-to-date: {skipped}")
    logger.info(f"   Failed: {failed}")
    logger.info(f"   Total records inserted: {total_inserted}")
    
    return total_inserted


# ============================================================================
# MAIN EXECUTION
# ============================================================================

async def connect_to_database():
    """Connect to database using parsed URL to avoid SCRAM auth issues with special chars."""
    parsed = urlparse(DATABASE_URL)
    
    # Parse connection parameters
    conn_params = {
        'host': parsed.hostname,
        'port': parsed.port or 5432,
        'database': parsed.path.lstrip('/'),
        'user': parsed.username,
        'password': parsed.password
    }
    
    logger.info(f"🔌 Connecting to database: {conn_params['user']}@{conn_params['host']}:{conn_params['port']}/{conn_params['database']}")
    
    return await asyncpg.connect(**conn_params)


async def main():
    """Main sync function."""
    logger.info("🚀 COMPREHENSIVE DAILY SYNC - STARTING")
    logger.info("="*60)
    logger.info(f"⏰ Started at: {date.today()}")
    logger.info(f"📊 Shorts sync: Last {SYNC_DAYS_SHORTS} days")
    logger.info(f"💰 Stock prices sync: Last {SYNC_DAYS_STOCK_PRICES} days")
    if ALPHA_VANTAGE_ENABLED:
        logger.info(f"🔑 Alpha Vantage: ENABLED (primary)")
        logger.info(f"📊 Yahoo Finance: ENABLED (fallback)")
    else:
        logger.info(f"📊 Yahoo Finance: ENABLED (only)")
    logger.info("="*60)
    
    start_time = time.time()
    
    conn = await connect_to_database()
    
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

