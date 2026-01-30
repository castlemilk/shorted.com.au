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
import signal
import sys
from pathlib import Path
import logging
from typing import List, Dict, Set, Optional
from urllib.parse import urlparse, parse_qs, unquote

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
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
SYNC_KEY_METRICS = os.getenv("SYNC_KEY_METRICS", "true").lower() == "true"
SYNC_BATCH_SIZE = int(
    os.getenv("SYNC_BATCH_SIZE", "500")
)  # Stocks per batch to avoid timeout
RATE_LIMIT_DELAY_ALPHA = 12.0  # Alpha Vantage: 5 calls/minute
RATE_LIMIT_DELAY_YAHOO = 1.0  # Yahoo Finance: base delay between requests
RATE_LIMIT_DELAY_YAHOO_MAX = 30.0  # Max backoff delay
CONSECUTIVE_FAILURES_BACKOFF_THRESHOLD = 3  # Start backing off after this many failures
MAX_STOCK_FAILURE_RETRIES = int(
    os.getenv("MAX_STOCK_FAILURE_RETRIES", "3")
)  # Max retries per stock before permanently skipping
import json
import uuid
import socket
import sys

# Add market-data directory to path for gap_detector
sys.path.append(
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "market-data"
    )
)
try:
    from gap_detector import find_gaps
except ImportError:
    logger.warning("⚠️  Could not import gap_detector, gap filling will be disabled")
    find_gaps = None


# ============================================================================
# SYNC STATUS RECORDING
# ============================================================================


class SyncStatusRecorder:
    """Records sync progress and metrics to the database."""

    def __init__(self, conn, run_id: Optional[str] = None):
        self.conn = conn
        self.run_id = run_id or str(uuid.uuid4())
        self.started_at = None
        self.metrics = {
            "shorts_records_updated": 0,
            "prices_records_updated": 0,
            "prices_alpha_success": 0,
            "prices_yahoo_success": 0,
            "prices_failed": 0,
            "prices_skipped": 0,
            "metrics_records_updated": 0,
            "metrics_failed": 0,
            "algolia_records_synced": 0,
        }
        # Use integer counts instead of arrays (matches migration 000013 schema)
        self.checkpoint_data = {
            "stocks_processed": 0,  # Count of processed stocks
            "stocks_successful": 0,  # Count of successful stocks
            "stocks_failed": 0,  # Count of failed stocks
            "stocks_failed_set": set(),  # Track which stocks failed for retry logic
            "stocks_failed_count": {},  # Track failure count per stock: {stock_code: count}
            "resume_from": 0,
        }

    async def start(
        self, total_stocks: int = 0, batch_size: int = 500, resume_from: int = 0
    ):
        """Record start of sync run."""
        self.started_at = time.time()
        
        # Get hostname - prefer Cloud Run identifiers over socket.gethostname()
        # Cloud Run sets K_SERVICE for services and CLOUD_RUN_JOB for jobs
        hostname = (
            os.getenv("CLOUD_RUN_JOB") or 
            os.getenv("K_SERVICE") or 
            os.getenv("CLOUD_RUN_EXECUTION") or
            socket.gethostname()
        )
        environment = os.getenv("ENVIRONMENT", "development")

        # Check if this is a resume from checkpoint
        existing = await self.conn.fetchrow(
            """
            SELECT run_id, checkpoint_stocks_processed, checkpoint_stocks_successful,
                   checkpoint_stocks_failed, checkpoint_resume_from, status
            FROM sync_status
            WHERE run_id = $1
        """,
            self.run_id,
        )

        if existing and existing["status"] in ("running", "partial"):
            # Resume from checkpoint - checkpoint columns are now integers
            logger.info(f"🔄 Resuming sync run {self.run_id} from checkpoint")
            self.checkpoint_data["stocks_processed"] = existing["checkpoint_stocks_processed"] or 0
            self.checkpoint_data["stocks_successful"] = existing["checkpoint_stocks_successful"] or 0
            self.checkpoint_data["stocks_failed"] = existing["checkpoint_stocks_failed"] or 0
            self.checkpoint_data["resume_from"] = existing["checkpoint_resume_from"] or 0
            # Note: We can no longer track which specific stocks failed with integer schema
            # but we can still track failure counts per stock in memory for this run
            self.checkpoint_data["stocks_failed_count"] = {}
            self.checkpoint_data["stocks_failed_set"] = set()

            # Update existing checkpoint
            await self.conn.execute(
                """
                UPDATE sync_status SET
                    status = 'running',
                    started_at = CURRENT_TIMESTAMP,
                    checkpoint_stocks_total = COALESCE($2, checkpoint_stocks_total),
                    checkpoint_batch_size = COALESCE($3, checkpoint_batch_size)
                WHERE run_id = $1
            """,
                self.run_id,
                total_stocks if total_stocks > 0 else None,
                batch_size if batch_size > 0 else None,
            )
        else:
            # New run - insert with integer columns (migration 000013 schema)
            await self.conn.execute(
                """
                INSERT INTO sync_status (
                    run_id, status, environment, hostname,
                    checkpoint_stocks_total, checkpoint_batch_size, checkpoint_resume_from,
                    checkpoint_stocks_processed, checkpoint_stocks_successful, checkpoint_stocks_failed
                ) VALUES ($1, 'running', $2, $3, $4, $5, $6, 0, 0, 0)
            """,
                self.run_id,
                environment,
                hostname,
                total_stocks,
                batch_size,
                resume_from,
            )

        logger.info(f"📝 Sync run started with ID: {self.run_id}")
        if resume_from > 0:
            logger.info(f"📍 Resuming from stock index {resume_from}/{total_stocks}")

    async def update_metric(self, metric_name: str, value: int, increment: bool = True):
        """Update a specific metric."""
        if metric_name in self.metrics:
            if increment:
                self.metrics[metric_name] += value
            else:
                self.metrics[metric_name] = value

    async def update_checkpoint(self, stock_code: str, success: bool, index: int):
        """Update checkpoint with processed stock (using integer counts)."""
        if success:
            self.checkpoint_data["stocks_successful"] += 1
            # Reset failure count on success
            self.checkpoint_data["stocks_failed_count"].pop(stock_code, None)
            self.checkpoint_data["stocks_failed_set"].discard(stock_code)
        else:
            # Increment failure count
            current_count = self.checkpoint_data["stocks_failed_count"].get(
                stock_code, 0
            )
            self.checkpoint_data["stocks_failed_count"][stock_code] = current_count + 1
            # Track failed stocks for retry logic (in memory only)
            if stock_code not in self.checkpoint_data["stocks_failed_set"]:
                self.checkpoint_data["stocks_failed_set"].add(stock_code)
                self.checkpoint_data["stocks_failed"] += 1

        self.checkpoint_data["stocks_processed"] += 1
        self.checkpoint_data["resume_from"] = index + 1

        # Update database checkpoint (only update every 10 stocks to reduce DB load)
        processed_count = self.checkpoint_data["stocks_processed"]
        should_update = (processed_count > 0 and processed_count % 10 == 0)

        if should_update:
            duration = time.time() - (self.started_at or time.time())

            # Use integer columns (migration 000013 schema)
            await self.conn.execute(
                """
                UPDATE sync_status SET
                    checkpoint_stocks_processed = $2,
                    checkpoint_stocks_successful = $3,
                    checkpoint_stocks_failed = $4,
                    checkpoint_resume_from = $5,
                    shorts_records_updated = $6,
                    prices_records_updated = $7,
                    prices_alpha_success = $8,
                    prices_yahoo_success = $9,
                    prices_failed = $10,
                    prices_skipped = $11,
                    metrics_records_updated = $12,
                    total_duration_seconds = $13,
                    status = CASE 
                        WHEN $2 >= checkpoint_stocks_total THEN 'completed'
                        ELSE 'partial'
                    END
                WHERE run_id = $1
            """,
                self.run_id,
                self.checkpoint_data["stocks_processed"],
                self.checkpoint_data["stocks_successful"],
                self.checkpoint_data["stocks_failed"],
                self.checkpoint_data["resume_from"],
                self.metrics["shorts_records_updated"],
                self.metrics["prices_records_updated"],
                self.metrics["prices_alpha_success"],
                self.metrics["prices_yahoo_success"],
                self.metrics["prices_failed"],
                self.metrics["prices_skipped"],
                self.metrics["metrics_records_updated"],
                duration,
            )

    async def complete(self, all_stocks_complete: bool = True):
        """Record successful completion."""
        duration = time.time() - (self.started_at or time.time())

        logger.info(f"📝 Recording completion with metrics: {self.metrics}")

        try:
            status = "completed" if all_stocks_complete else "partial"
            # Use integer columns (migration 000013 schema)
            await self.conn.execute(
                """
                UPDATE sync_status SET
                    status = $2,
                    completed_at = CURRENT_TIMESTAMP,
                    shorts_records_updated = $3,
                    prices_records_updated = $4,
                    prices_alpha_success = $5,
                    prices_yahoo_success = $6,
                    prices_failed = $7,
                    prices_skipped = $8,
                    metrics_records_updated = $9,
                    metrics_failed = $10,
                    algolia_records_synced = $11,
                    total_duration_seconds = $12,
                    checkpoint_stocks_processed = $13,
                    checkpoint_stocks_successful = $14,
                    checkpoint_stocks_failed = $15,
                    checkpoint_resume_from = $16
                WHERE run_id = $1
            """,
                self.run_id,
                status,
                self.metrics["shorts_records_updated"],
                self.metrics["prices_records_updated"],
                self.metrics["prices_alpha_success"],
                self.metrics["prices_yahoo_success"],
                self.metrics["prices_failed"],
                self.metrics["prices_skipped"],
                self.metrics["metrics_records_updated"],
                self.metrics["metrics_failed"],
                self.metrics["algolia_records_synced"],
                duration,
                self.checkpoint_data["stocks_processed"],
                self.checkpoint_data["stocks_successful"],
                self.checkpoint_data["stocks_failed"],
                self.checkpoint_data["resume_from"],
            )

            if all_stocks_complete:
                logger.info(f"📝 Sync run completed successfully")
            else:
                logger.info(
                    f"📝 Sync run partially completed - {self.checkpoint_data['stocks_processed']} stocks processed"
                )
        except Exception as e:
            logger.error(f"❌ Failed to update sync_status to completed: {e}")
            raise

    async def fail(self, error_message: str):
        """Record failure."""
        duration = time.time() - (self.started_at or time.time())

        await self.conn.execute(
            """
            UPDATE sync_status SET
                status = 'failed',
                completed_at = CURRENT_TIMESTAMP,
                error_message = $2,
                total_duration_seconds = $3
            WHERE run_id = $1
        """,
            self.run_id,
            error_message,
            duration,
        )

        logger.error(f"📝 Sync run marked as failed: {error_message}")


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
        return last_date.date() if hasattr(last_date, "date") else last_date
    return None


async def get_recent_shorts_files(
    days: int = 7, since_date: Optional[date] = None
) -> List[str]:
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


async def update_shorts_data(
    conn, days: int = 7, recorder: Optional[SyncStatusRecorder] = None
):
    """Update shorts position data from ASIC."""
    logger.info("\n" + "=" * 60)
    logger.info("📊 UPDATING SHORTS DATA")
    logger.info("=" * 60)

    # Check last ingested date
    last_date = await get_last_shorts_date(conn)
    if last_date:
        logger.info(f"   Last ingested shorts date: {last_date}")
        # If we have data from today, skip
        if last_date >= date.today():
            logger.info(f"   ✓ Already up to date!")
            return 0
        # Fetch from last date onwards
        urls = await get_recent_shorts_files(
            days=days, since_date=last_date + timedelta(days=1)
        )
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
                    # Convert numpy.datetime64 to Python date
                    date_val = pd.Timestamp(record["DATE"]).date()

                    await conn.execute(
                        """
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
                        """,
                        date_val,
                        str(record["PRODUCT"]),
                        str(record["PRODUCT_CODE"]),
                        float(record["REPORTED_SHORT_POSITIONS"] or 0),
                        float(record["TOTAL_PRODUCT_IN_ISSUE"] or 0),
                        float(
                            record[
                                "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
                            ]
                            or 0
                        ),
                    )
                    inserted += 1
                except Exception as e:
                    if inserted == 0:  # Log first error for debugging
                        logger.debug(f"Insert error: {e}")
                    continue

            total_inserted += inserted
            logger.info(f"  ✅ Inserted/Updated {inserted} records")

        except Exception as e:
            logger.error(f"  ❌ Error: {str(e)[:100]}")

    logger.info(f"\n✅ Shorts update complete: {total_inserted} total records updated")

    if recorder:
        await recorder.update_metric("shorts_records_updated", total_inserted)

    return total_inserted


# ============================================================================
# STOCK PRICE SYNC WITH ALPHA VANTAGE + YAHOO FALLBACK
# ============================================================================


async def fetch_from_alpha_vantage(
    session: aiohttp.ClientSession, stock_code: str, days: int
) -> Optional[List[Dict]]:
    """Fetch recent price data from Alpha Vantage."""
    if not ALPHA_VANTAGE_API_KEY:
        return None

    try:
        # Alpha Vantage uses plain stock codes for ASX (strip .AX suffix if present)
        symbol = stock_code.replace(".AX", "")

        params = {
            "function": "TIME_SERIES_DAILY",
            "symbol": symbol,
            "apikey": ALPHA_VANTAGE_API_KEY,
            "outputsize": "compact",  # Last 100 days
        }

        async with session.get(
            "https://www.alphavantage.co/query", params=params
        ) as response:
            if response.status == 429:
                logger.warning(f"  ⚠️  Alpha Vantage rate limit hit")
                return None

            if response.status != 200:
                return None

            data = await response.json()

            # Check for errors
            if "Error Message" in data or "Note" in data or "Information" in data:
                return None

            time_series = data.get("Time Series (Daily)", {})
            if not time_series:
                return None

            # Convert to our format
            cutoff_date = date.today() - timedelta(days=days + 5)
            result = []

            for date_str, values in time_series.items():
                price_date = date.fromisoformat(date_str)
                if price_date < cutoff_date:
                    continue

                result.append(
                    {
                        "stock_code": stock_code,
                        "date": price_date,
                        "open": round(float(values["1. open"]), 2),
                        "high": round(float(values["2. high"]), 2),
                        "low": round(float(values["3. low"]), 2),
                        "close": round(float(values["4. close"]), 2),
                        "adjusted_close": round(float(values["4. close"]), 2),
                        "volume": int(values["5. volume"]),
                    }
                )

            return result if result else None

    except Exception as e:
        logger.debug(f"  Alpha Vantage error: {str(e)[:50]}")
        return None


def fetch_from_yahoo_finance(
    stock_code: str, days: int, max_retries: int = 3
) -> Optional[List[Dict]]:
    """Fetch recent price data from Yahoo Finance with retry and exponential backoff.

    Optimizations:
    - 404 errors (stock not found) are not retried since they won't recover
    - Rate limit errors (429) use exponential backoff
    - Empty responses are retried with backoff
    """
    # Add .AX suffix only if not already present
    yf_ticker = stock_code if stock_code.endswith(".AX") else f"{stock_code}.AX"

    for attempt in range(max_retries):
        try:
            ticker = yf.Ticker(yf_ticker)
            end_date = date.today()
            start_date = end_date - timedelta(days=days + 5)

            hist = ticker.history(start=start_date, end=end_date, interval="1d")

            if hist.empty:
                # Empty response might be rate limiting - backoff and retry
                if attempt < max_retries - 1:
                    backoff = RATE_LIMIT_DELAY_YAHOO * (2**attempt)
                    logger.debug(
                        f"  Empty response for {yf_ticker}, backing off {backoff:.1f}s"
                    )
                    time.sleep(min(backoff, RATE_LIMIT_DELAY_YAHOO_MAX))
                    continue
                return None

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
                        "volume": (
                            int(row["Volume"]) if not pd.isna(row["Volume"]) else 0
                        ),
                    }
                )

            return data if data else None

        except Exception as e:
            error_msg = str(e)

            # 404 errors (stock not found) - don't retry, these won't recover
            # Common patterns: "404", "Not Found", "Quote not found"
            if (
                "404" in error_msg
                or "Not Found" in error_msg
                or "Quote not found" in error_msg
                or "No data found" in error_msg
            ):
                # Log only on first attempt to reduce noise
                if attempt == 0:
                    logger.debug(f"  {yf_ticker}: Stock not found (404) - skipping retries")
                return None

            # Check for rate limit indicators - these should be retried
            if (
                "Expecting value" in error_msg
                or "Too Many Requests" in error_msg
                or "429" in error_msg
            ):
                if attempt < max_retries - 1:
                    backoff = RATE_LIMIT_DELAY_YAHOO * (2 ** (attempt + 1))
                    logger.warning(
                        f"  Rate limited on {yf_ticker}, backing off {backoff:.1f}s (attempt {attempt + 1}/{max_retries})"
                    )
                    time.sleep(min(backoff, RATE_LIMIT_DELAY_YAHOO_MAX))
                    continue

            # Log other errors only on final attempt
            if attempt == max_retries - 1:
                logger.error(
                    f"Failed to get ticker '{yf_ticker}' reason: {error_msg[:100]}"
                )
            return None

    return None


async def get_stocks_with_price_data(conn) -> List[str]:
    """Get list of stocks that already have price data."""
    stocks = await conn.fetch(
        "SELECT DISTINCT stock_code FROM stock_prices ORDER BY stock_code"
    )
    stock_list = [row["stock_code"] for row in stocks]
    logger.info(f"📋 Found {len(stock_list)} stocks with existing price data")
    return stock_list


async def get_last_ingested_date(conn, stock_code: str) -> Optional[date]:
    """Get the most recent date with price data for a given stock."""
    result = await conn.fetchrow(
        "SELECT MAX(date) as last_date FROM stock_prices WHERE stock_code = $1",
        stock_code,
    )
    if result and result["last_date"]:
        # Convert datetime to date if needed
        last_date = result["last_date"]
        return last_date.date() if hasattr(last_date, "date") else last_date
    return None


async def get_stock_dates(conn, stock_code: str) -> List[date]:
    """Get all dates with price data for a given stock."""
    rows = await conn.fetch(
        "SELECT date FROM stock_prices WHERE stock_code = $1 ORDER BY date ASC",
        stock_code,
    )
    return [row["date"] for row in rows]


def calculate_days_to_fetch(
    last_date: Optional[date], max_days: int = 365, min_overlap: int = 14
) -> int:
    """
    Calculate how many days of data to fetch based on last ingested date.

    Args:
        last_date: Most recent date with data for this stock
        max_days: Maximum days to fetch (default: 365 for initial backfill)
        min_overlap: Minimum overlap days to ensure no gaps (default: 14)

    Returns:
        Number of days of data to fetch
    """
    if not last_date:
        # No data yet, fetch default period
        return max_days

    days_missing = (date.today() - last_date).days

    # Add overlap days to ensure no gaps from holidays, weekends, API issues
    # 14 days overlap handles most holiday periods (e.g., Christmas/New Year)
    return min(days_missing + min_overlap, max_days)


async def insert_price_data(conn, data: List[Dict]) -> int:
    """Insert stock price data into database (upsert)."""
    if not data:
        return 0

    try:
        inserted = 0
        for d in data:
            try:
                await conn.execute(
                    """
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
                    """,
                    d["stock_code"],
                    d["date"],
                    d["open"],
                    d["high"],
                    d["low"],
                    d["close"],
                    d["adjusted_close"],
                    d["volume"],
                )
                inserted += 1
            except Exception:
                continue

        return inserted

    except Exception:
        return 0


async def check_data_health(conn) -> dict:
    """
    Check the health of historical stock price data.

    Returns a summary of data completeness for monitoring purposes.
    """
    try:
        # Get summary statistics
        summary = await conn.fetchrow(
            """
            SELECT 
                COUNT(*) as total_stocks,
                COUNT(CASE WHEN records < 500 THEN 1 END) as incomplete,
                COUNT(CASE WHEN records >= 500 AND records < 2000 THEN 1 END) as partial,
                COUNT(CASE WHEN records >= 2000 THEN 1 END) as complete
            FROM (
                SELECT stock_code, COUNT(*) as records 
                FROM stock_prices 
                GROUP BY stock_code
            ) sub
            """
        )

        # Get stocks with stale data (no update in last 7 days)
        stale_stocks = await conn.fetch(
            """
            SELECT stock_code, MAX(date) as last_date
            FROM stock_prices
            GROUP BY stock_code
            HAVING MAX(date) < CURRENT_DATE - INTERVAL '7 days'
            ORDER BY MAX(date) ASC
            LIMIT 10
            """
        )

        return {
            "total_stocks": summary["total_stocks"],
            "incomplete": summary["incomplete"],
            "partial": summary["partial"],
            "complete": summary["complete"],
            "stale_stocks": [(r["stock_code"], r["last_date"]) for r in stale_stocks],
            "health_score": round(
                (summary["complete"] / max(summary["total_stocks"], 1)) * 100, 1
            ),
        }
    except Exception as e:
        logger.error(f"❌ Error checking data health: {e}")
        return {
            "total_stocks": 0,
            "incomplete": 0,
            "partial": 0,
            "complete": 0,
            "stale_stocks": [],
            "health_score": 0,
        }


async def update_stock_prices(
    conn,
    days: int = 5,
    recorder: Optional[SyncStatusRecorder] = None,
    batch_size: int = 500,
    max_stocks: Optional[int] = None,
):
    """Update stock price data with Alpha Vantage primary, Yahoo Finance fallback.

    Supports checkpoint-based batch processing:
    - Processes stocks in batches to avoid timeout
    - Tracks progress in checkpoint
    - Can resume from checkpoint on retry
    """
    logger.info("\n" + "=" * 60)
    logger.info("💰 UPDATING STOCK PRICES")
    logger.info("=" * 60)

    if ALPHA_VANTAGE_ENABLED:
        logger.info("🔑 Alpha Vantage API key found - using as primary source")
        logger.info("📊 Yahoo Finance enabled as fallback")
    else:
        logger.info("⚠️  No Alpha Vantage API key - using Yahoo Finance only")

    stocks = await get_stocks_with_price_data(conn)

    if not stocks:
        logger.warning("⚠️  No stocks with existing price data")
        return 0

    # Get checkpoint info - using integer counts now (not stock lists)
    # The resume_from index is the main mechanism for skipping already-processed stocks
    resume_from = recorder.checkpoint_data["resume_from"] if recorder else 0
    # Note: With integer counts, we can't track which specific stocks were processed/successful
    # from previous runs. We rely on resume_from index for resumption, which skips stocks at line 868.
    # Within-run tracking uses in-memory sets initialized here:
    successful_stocks_this_run = set()  # Track successful stocks within this run (in memory only)
    failed_stocks_count = (
        recorder.checkpoint_data["stocks_failed_count"] if recorder else {}
    )
    permanently_failed_stocks = {
        stock
        for stock, count in failed_stocks_count.items()
        if count >= MAX_STOCK_FAILURE_RETRIES
    }

    # Filter out already processed stocks
    if resume_from > 0:
        stocks = stocks[resume_from:]
        logger.info(
            f"📍 Resuming from index {resume_from}, {len(stocks)} stocks remaining"
        )

    # Limit batch size if specified
    if max_stocks:
        stocks = stocks[:max_stocks]
        logger.info(f"📦 Processing batch of {len(stocks)} stocks (max: {max_stocks})")

    total_stocks = len(stocks) + resume_from
    logger.info(
        f"🔄 Updating {len(stocks)} stocks (from last ingested date to today)\n"
    )

    total_inserted = 0
    alpha_success = 0
    yahoo_success = 0
    failed = 0
    skipped = 0

    # Create aiohttp session for Alpha Vantage
    session = aiohttp.ClientSession() if ALPHA_VANTAGE_ENABLED else None

    consecutive_failures = 0
    current_delay = RATE_LIMIT_DELAY_YAHOO

    try:
        for i, stock_code in enumerate(stocks, 1):
            current_index = resume_from + i - 1

            # Check for termination signal periodically
            if _terminating:
                logger.warning(
                    f"⚠️  Termination signal received at stock {current_index}/{total_stocks}, saving checkpoint"
                )
                if recorder:
                    await recorder.update_checkpoint(stock_code, False, current_index)
                break

            # Skip if already successfully processed within this run
            # (Stocks from previous runs are already skipped via resume_from at line 868)
            if stock_code in successful_stocks_this_run:
                logger.info(
                    f"[{current_index:4d}/{total_stocks}] {stock_code}: ✓ Already processed (skipping)"
                )
                skipped += 1
                if recorder:
                    await recorder.update_checkpoint(stock_code, True, current_index)
                continue

            # Skip permanently failed stocks (exceeded max retries)
            if stock_code in permanently_failed_stocks:
                failure_count = failed_stocks_count.get(stock_code, 0)
                logger.warning(
                    f"[{current_index:4d}/{total_stocks}] {stock_code}: ⛔ Permanently failed ({failure_count} failures, max: {MAX_STOCK_FAILURE_RETRIES}) - skipping"
                )
                skipped += 1
                if recorder:
                    # Mark as processed but not successful to avoid retrying
                    await recorder.update_checkpoint(stock_code, False, current_index)
                continue
            # Check last ingested date and potential gaps for this stock
            last_date = await get_last_ingested_date(conn, stock_code)

            # Identify gaps if gap_detector is available
            gap_ranges = []
            if find_gaps:
                actual_dates = await get_stock_dates(conn, stock_code)
                if actual_dates:
                    # Look for gaps in the last 2 years (or whatever limit is appropriate)
                    start_lookback = date.today() - timedelta(days=730)
                    gap_ranges = find_gaps(
                        actual_dates, start_date=max(actual_dates[0], start_lookback)
                    )

            days_to_fetch = calculate_days_to_fetch(last_date, max_days=days)

            # Skip if we already have today's data and no gaps
            if last_date and last_date >= date.today() and not gap_ranges:
                logger.info(
                    f"[{current_index:4d}/{total_stocks}] {stock_code}: ✓ Already up to date and no gaps (last: {last_date})"
                )
                skipped += 1
                if recorder:
                    await recorder.update_checkpoint(stock_code, True, current_index)
                continue

            if gap_ranges:
                logger.info(
                    f"[{current_index:4d}/{total_stocks}] {stock_code}: 🔍 Found {len(gap_ranges)} gaps to fill"
                )
                # For gaps, we might want to fetch a longer period that covers the gaps
                # or handle them specifically. For now, we'll ensure days_to_fetch
                # covers at least the oldest gap if it's reasonably recent.
                oldest_gap_date = min(g[0] for g in gap_ranges)
                days_to_oldest_gap = (date.today() - oldest_gap_date).days
                days_to_fetch = max(days_to_fetch, min(days_to_oldest_gap + 5, 365))

            data = None
            source = None

            # Try Alpha Vantage first
            if ALPHA_VANTAGE_ENABLED and session:
                data = await fetch_from_alpha_vantage(
                    session, stock_code, days_to_fetch
                )
                if data:
                    source = "Alpha Vantage"
                    alpha_success += 1
                    consecutive_failures = 0
                    current_delay = RATE_LIMIT_DELAY_YAHOO
                    # Respect Alpha Vantage rate limits
                    await asyncio.sleep(RATE_LIMIT_DELAY_ALPHA)

            # Fallback to Yahoo Finance
            if not data:
                # Always add base delay before Yahoo request
                time.sleep(current_delay)

                data = fetch_from_yahoo_finance(stock_code, days_to_fetch)
                if data:
                    source = "Yahoo Finance"
                    yahoo_success += 1
                    consecutive_failures = 0
                    current_delay = RATE_LIMIT_DELAY_YAHOO  # Reset delay on success

            if not data:
                last_info = f"last: {last_date}" if last_date else "no data yet"
                failure_count = failed_stocks_count.get(stock_code, 0) + 1

                # Check if this stock has exceeded max retries
                if failure_count >= MAX_STOCK_FAILURE_RETRIES:
                    logger.warning(
                        f"[{current_index:4d}/{total_stocks}] {stock_code}: ⛔ Permanently failed ({failure_count}/{MAX_STOCK_FAILURE_RETRIES} failures) - will skip in future runs"
                    )
                else:
                    logger.info(
                        f"[{current_index:4d}/{total_stocks}] {stock_code}: ⚠️  No data from any source ({last_info}, failure {failure_count}/{MAX_STOCK_FAILURE_RETRIES})"
                    )

                failed += 1
                consecutive_failures += 1

                # Increase delay on consecutive failures (circuit breaker pattern)
                # This helps with rate limiting and temporary API issues
                if consecutive_failures >= CONSECUTIVE_FAILURES_BACKOFF_THRESHOLD:
                    current_delay = min(current_delay * 1.5, RATE_LIMIT_DELAY_YAHOO_MAX)
                    if consecutive_failures % 10 == 0:
                        logger.warning(
                            f"⚠️  {consecutive_failures} consecutive failures, backing off to {current_delay:.1f}s delay (rate limit protection)"
                        )

                # Update checkpoint even for failures
                if recorder:
                    await recorder.update_checkpoint(stock_code, False, current_index)
                continue

            # Insert data
            inserted = await insert_price_data(conn, data)
            success = inserted > 0

            if success:
                last_info = f"from {last_date}" if last_date else "initial load"
                logger.info(
                    f"[{current_index:4d}/{total_stocks}] {stock_code}: ✅ {inserted} records ({source}, {last_info})"
                )
                total_inserted += inserted
                successful_stocks_this_run.add(stock_code)  # Track for within-run deduplication
            else:
                failure_count = failed_stocks_count.get(stock_code, 0) + 1
                if failure_count >= MAX_STOCK_FAILURE_RETRIES:
                    logger.warning(
                        f"[{current_index:4d}/{total_stocks}] {stock_code}: ⛔ Insert failed ({failure_count}/{MAX_STOCK_FAILURE_RETRIES} failures) - will skip in future"
                    )
                else:
                    logger.info(
                        f"[{current_index:4d}/{total_stocks}] {stock_code}: ❌ Insert failed (failure {failure_count}/{MAX_STOCK_FAILURE_RETRIES})"
                    )
                failed += 1

            # Update checkpoint after each stock
            if recorder:
                await recorder.update_checkpoint(stock_code, success, current_index)

    finally:
        if session:
            await session.close()

    permanently_skipped = len(permanently_failed_stocks) if recorder else 0

    logger.info(f"\n✅ Stock prices update complete:")
    logger.info(f"   Alpha Vantage: {alpha_success}")
    logger.info(f"   Yahoo Finance: {yahoo_success}")
    logger.info(f"   Already up-to-date: {skipped}")
    logger.info(f"   Failed (this run): {failed}")
    if permanently_skipped > 0:
        logger.warning(
            f"   ⛔ Permanently skipped (exceeded {MAX_STOCK_FAILURE_RETRIES} retries): {permanently_skipped}"
        )
    logger.info(f"   Total records inserted: {total_inserted}")

    if recorder:
        await recorder.update_metric("prices_records_updated", total_inserted)
        await recorder.update_metric("prices_alpha_success", alpha_success)
        await recorder.update_metric("prices_yahoo_success", yahoo_success)
        await recorder.update_metric("prices_failed", failed)
        await recorder.update_metric("prices_skipped", skipped)

    return total_inserted


# ============================================================================
# KEY METRICS SYNC
# ============================================================================


def fetch_key_metrics_from_yahoo(
    stock_code: str, max_retries: int = 3
) -> Optional[Dict]:
    """Fetch key metrics from Yahoo Finance for a single stock with retry and backoff.

    Optimizations:
    - 404 errors (stock not found) are not retried since they won't recover
    - Rate limit errors (429) use exponential backoff
    """
    yahoo_symbol = f"{stock_code}.AX"

    for attempt in range(max_retries):
        try:
            ticker = yf.Ticker(yahoo_symbol)
            info = ticker.info

            if not info or info.get("regularMarketPrice") is None:
                # Empty response - possible rate limit
                if attempt < max_retries - 1:
                    backoff = RATE_LIMIT_DELAY_YAHOO * (2**attempt)
                    time.sleep(min(backoff, RATE_LIMIT_DELAY_YAHOO_MAX))
                    continue
                return None

            return {
                "stock_code": stock_code,
                "market_cap": info.get("marketCap"),
                "pe_ratio": info.get("trailingPE"),
                "forward_pe": info.get("forwardPE"),
                "eps": info.get("trailingEps"),
                "dividend_yield": info.get("dividendYield"),
                "book_value": info.get("bookValue"),
                "price_to_book": info.get("priceToBook"),
                "revenue": info.get("totalRevenue"),
                "profit_margin": info.get("profitMargins"),
                "debt_to_equity": info.get("debtToEquity"),
                "return_on_equity": info.get("returnOnEquity"),
                "fifty_two_week_high": info.get("fiftyTwoWeekHigh"),
                "fifty_two_week_low": info.get("fiftyTwoWeekLow"),
                "avg_volume": info.get("averageVolume"),
                "beta": info.get("beta"),
            }
        except Exception as e:
            error_msg = str(e)

            # 404 errors (stock not found) - don't retry, these won't recover
            if (
                "404" in error_msg
                or "Not Found" in error_msg
                or "Quote not found" in error_msg
                or "No data found" in error_msg
            ):
                return None

            # Rate limit errors - retry with backoff
            if (
                "Expecting value" in error_msg
                or "Too Many Requests" in error_msg
                or "429" in error_msg
            ):
                if attempt < max_retries - 1:
                    backoff = RATE_LIMIT_DELAY_YAHOO * (2 ** (attempt + 1))
                    logger.debug(
                        f"  Rate limited on {yahoo_symbol}, backing off {backoff:.1f}s"
                    )
                    time.sleep(min(backoff, RATE_LIMIT_DELAY_YAHOO_MAX))
                    continue
            return None

    return None


async def update_key_metrics(
    conn, batch_size: int = 50, recorder: Optional[SyncStatusRecorder] = None
):
    """Update key metrics for all stocks in company-metadata table."""
    logger.info("\n" + "=" * 60)
    logger.info("📈 UPDATING KEY METRICS")
    logger.info("=" * 60)

    # Get all stocks that need metrics updated
    stocks = await conn.fetch(
        """
        SELECT stock_code FROM "company-metadata" 
        WHERE stock_code IS NOT NULL 
        ORDER BY stock_code
    """
    )
    stock_list = [row["stock_code"] for row in stocks]

    if not stock_list:
        logger.warning("⚠️  No stocks found in company-metadata")
        return 0

    logger.info(f"🔄 Updating key metrics for {len(stock_list)} stocks\n")

    updated = 0
    failed = 0
    consecutive_failures = 0
    current_delay = RATE_LIMIT_DELAY_YAHOO

    for i, stock_code in enumerate(stock_list, 1):
        # Always add delay before request
        time.sleep(current_delay)

        metrics = fetch_key_metrics_from_yahoo(stock_code)

        if not metrics:
            if i <= 10 or i % 100 == 0:  # Log first 10 and every 100th
                logger.info(
                    f"[{i:4d}/{len(stock_list)}] {stock_code}: ⚠️  No metrics available"
                )
            failed += 1
            consecutive_failures += 1

            # Increase delay on consecutive failures
            if consecutive_failures >= CONSECUTIVE_FAILURES_BACKOFF_THRESHOLD:
                current_delay = min(current_delay * 1.5, RATE_LIMIT_DELAY_YAHOO_MAX)
                if consecutive_failures % 10 == 0:
                    logger.warning(
                        f"⚠️  {consecutive_failures} consecutive failures, backing off to {current_delay:.1f}s delay"
                    )
            continue

        try:
            await conn.execute(
                """
                UPDATE "company-metadata"
                SET 
                    key_metrics = $2::jsonb,
                    key_metrics_updated_at = CURRENT_TIMESTAMP
                WHERE stock_code = $1
            """,
                stock_code,
                json.dumps(metrics),
            )

            if i <= 10 or i % 100 == 0:
                logger.info(
                    f"[{i:4d}/{len(stock_list)}] {stock_code}: ✅ Updated (P/E: {metrics.get('pe_ratio', 'N/A')}, MCap: {metrics.get('market_cap', 'N/A')})"
                )
            updated += 1
            consecutive_failures = 0  # Reset on success
            current_delay = RATE_LIMIT_DELAY_YAHOO  # Reset delay on success

        except Exception as e:
            logger.error(f"[{i:4d}/{len(stock_list)}] {stock_code}: ❌ DB error: {e}")
            failed += 1

    logger.info(f"\n✅ Key metrics update complete:")
    logger.info(f"   Updated: {updated}")
    logger.info(f"   Failed/No data: {failed}")

    if recorder:
        await recorder.update_metric("metrics_records_updated", updated)
        await recorder.update_metric("metrics_failed", failed)

    return updated


# ============================================================================
# MAIN EXECUTION
# ============================================================================


async def connect_to_database():
    """Connect to database using parsed URL to avoid SCRAM auth issues with special chars."""
    parsed = urlparse(DATABASE_URL)

    # Parse connection parameters
    conn_params = {
        "host": parsed.hostname,
        "port": parsed.port or 5432,
        "database": parsed.path.lstrip("/"),
        "user": parsed.username,
        "password": parsed.password,
        # Disable prepared statements for pgbouncer transaction pooler compatibility
        "statement_cache_size": 0,
    }

    logger.info(
        f"🔌 Connecting to database: {conn_params['user']}@{conn_params['host']}:{conn_params['port']}/{conn_params['database']}"
    )

    return await asyncpg.connect(**conn_params)


async def cleanup_stuck_runs(conn) -> int:
    """Mark stuck 'running' jobs as failed.

    Jobs are considered stuck if they've been running for more than 5 hours
    (longer than the 4-hour timeout to account for any delays).

    Returns the number of cleaned up runs.
    """
    result = await conn.execute(
        """
        UPDATE sync_status
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error_message = 'Job timed out (cleaned up by next run)'
        WHERE status = 'running'
          AND started_at < NOW() - INTERVAL '5 hours'
        """
    )

    # Parse the result to get count (format: "UPDATE N")
    count = 0
    if result:
        parts = result.split()
        if len(parts) >= 2:
            try:
                count = int(parts[1])
            except ValueError:
                pass

    if count > 0:
        logger.info(f"🧹 Cleaned up {count} stuck job(s) from previous runs")

    return count


async def get_or_create_daily_sync_run(conn, batch_size: int = 500) -> Optional[str]:
    """Get existing incomplete daily sync run or return None to create new one."""
    today = date.today()

    # Find incomplete sync from today
    incomplete = await conn.fetchrow(
        """
        SELECT run_id, checkpoint_resume_from, checkpoint_stocks_total,
               checkpoint_stocks_processed, checkpoint_stocks_successful
        FROM sync_status
        WHERE DATE(started_at) = $1
          AND status IN ('running', 'partial')
        ORDER BY started_at DESC
        LIMIT 1
    """,
        today,
    )

    if incomplete:
        # checkpoint_stocks_processed is now an INTEGER, not an array
        processed_count = incomplete["checkpoint_stocks_processed"] or 0
        total = incomplete["checkpoint_stocks_total"] or 0
        resume_from = incomplete["checkpoint_resume_from"] or 0

        if processed_count < total:
            logger.info(f"🔄 Found incomplete sync run: {incomplete['run_id']}")
            logger.info(
                f"   Progress: {processed_count}/{total} stocks ({resume_from} index)"
            )
            return incomplete["run_id"]

    return None


# Global variable to track if we're being terminated
_terminating = False
_recorder_instance = None


def handle_timeout(signum, frame):
    """Handle timeout signal from Cloud Run (SIGTERM)"""
    global _terminating
    logger.warning("⚠️  Received termination signal (likely timeout)")
    _terminating = True
    # Don't try to update database here - connection may be closed
    # The main async function will check _terminating flag and handle it
    # Just set the flag and let the async code handle the cleanup


async def main() -> bool:
    """Main sync function.

    Returns:
        bool: True if all stocks processed, False if partial completion
    """
    # Set up signal handlers for timeout detection
    signal.signal(signal.SIGTERM, handle_timeout)
    signal.signal(signal.SIGINT, handle_timeout)

    # #region agent log
    import json

    try:
        with open("/Users/benebsworth/projects/shorted/.cursor/debug.log", "a") as f:
            f.write(
                json.dumps(
                    {
                        "timestamp": time.time() * 1000,
                        "location": "comprehensive_daily_sync.py:871",
                        "message": "main() entry",
                        "data": {},
                        "sessionId": "debug-session",
                        "runId": "run1",
                        "hypothesisId": "A",
                    }
                )
                + "\n"
            )
    except:
        pass
    # #endregion

    logger.info("🚀 COMPREHENSIVE DAILY SYNC - STARTING")
    logger.info("=" * 60)
    logger.info(f"⏰ Started at: {date.today()}")
    logger.info(f"📊 Shorts sync: Last {SYNC_DAYS_SHORTS} days")
    logger.info(f"💰 Stock prices sync: Last {SYNC_DAYS_STOCK_PRICES} days")
    logger.info(f"📈 Key metrics sync: {'ENABLED' if SYNC_KEY_METRICS else 'DISABLED'}")
    if ALPHA_VANTAGE_ENABLED:
        logger.info(f"🔑 Alpha Vantage: ENABLED (primary)")
        logger.info(f"📊 Yahoo Finance: ENABLED (fallback)")
    else:
        logger.info(f"📊 Yahoo Finance: ENABLED (only)")
    logger.info("=" * 60)

    start_time = time.time()

    # #region agent log
    try:
        with open("/Users/benebsworth/projects/shorted/.cursor/debug.log", "a") as f:
            f.write(
                json.dumps(
                    {
                        "timestamp": time.time() * 1000,
                        "location": "comprehensive_daily_sync.py:888",
                        "message": "before connect_to_database()",
                        "data": {},
                        "sessionId": "debug-session",
                        "runId": "run1",
                        "hypothesisId": "A",
                    }
                )
                + "\n"
            )
    except:
        pass
    # #endregion

    conn = await connect_to_database()

    # Clean up any stuck runs from previous executions before starting
    await cleanup_stuck_runs(conn)

    # #region agent log
    try:
        with open("/Users/benebsworth/projects/shorted/.cursor/debug.log", "a") as f:
            f.write(
                json.dumps(
                    {
                        "timestamp": time.time() * 1000,
                        "location": "comprehensive_daily_sync.py:890",
                        "message": "after connect_to_database(), before recorder",
                        "data": {"conn": "connected" if conn else "None"},
                        "sessionId": "debug-session",
                        "runId": "run1",
                        "hypothesisId": "A",
                    }
                )
                + "\n"
            )
    except:
        pass
    # #endregion

    # Check for existing incomplete sync run and get total stocks count
    BATCH_SIZE = int(os.getenv("SYNC_BATCH_SIZE", "500"))  # Stocks per batch
    all_stocks = await get_stocks_with_price_data(conn)
    total_stocks = len(all_stocks) if all_stocks else 0
    existing_run_id = await get_or_create_daily_sync_run(conn, BATCH_SIZE)

    recorder = SyncStatusRecorder(conn, run_id=existing_run_id)
    global _recorder_instance
    _recorder_instance = recorder

    try:
        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:892",
                            "message": "before recorder.start()",
                            "data": {"run_id": recorder.run_id},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "A",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        await recorder.start(
            total_stocks=total_stocks,
            batch_size=BATCH_SIZE,
            resume_from=recorder.checkpoint_data["resume_from"],
        )

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:894",
                            "message": "after recorder.start()",
                            "data": {},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "A",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        # Check for termination signal
        if _terminating:
            logger.warning("⚠️  Termination signal received, aborting")
            await recorder.fail("Job terminated before completion")
            return False  # Return False to indicate incomplete

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:895",
                            "message": "before update_shorts_data()",
                            "data": {},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "B",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        # Update shorts data
        shorts_updated = await update_shorts_data(conn, SYNC_DAYS_SHORTS, recorder)

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:897",
                            "message": "after update_shorts_data()",
                            "data": {"shorts_updated": shorts_updated},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "B",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        # Check for termination signal
        if _terminating:
            logger.warning("⚠️  Termination signal received, aborting")
            await recorder.fail("Job terminated during stock price update")
            return

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:898",
                            "message": "before update_stock_prices()",
                            "data": {},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "C",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        # Calculate how many stocks to process in this batch
        # Process up to BATCH_SIZE stocks, or remaining if less
        remaining_stocks = total_stocks - recorder.checkpoint_data["resume_from"]
        batch_limit = (
            min(BATCH_SIZE, remaining_stocks) if remaining_stocks > 0 else BATCH_SIZE
        )

        logger.info(
            f"📦 Processing batch: {batch_limit} stocks (remaining: {remaining_stocks}, total: {total_stocks})"
        )

        # Update stock prices with checkpoint support
        prices_updated = await update_stock_prices(
            conn,
            days=SYNC_DAYS_STOCK_PRICES,
            recorder=recorder,
            batch_size=BATCH_SIZE,
            max_stocks=batch_limit,
        )

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:900",
                            "message": "after update_stock_prices()",
                            "data": {"prices_updated": prices_updated},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "C",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        # Check for termination signal before completing
        if _terminating:
            logger.warning("⚠️  Termination signal received, marking as failed")
            await recorder.fail("Job terminated before completion")
            return False  # Return False to indicate incomplete

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:1164",
                            "message": "before update_key_metrics()",
                            "data": {"SYNC_KEY_METRICS": SYNC_KEY_METRICS},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "G",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        # Update key metrics (P/E, market cap, etc.) from Yahoo Finance
        metrics_updated = 0
        if SYNC_KEY_METRICS:
            try:
                metrics_updated = await update_key_metrics(
                    conn, batch_size=50, recorder=recorder
                )
            except Exception as e:
                logger.error(f"❌ Error updating key metrics: {e}")
                metrics_updated = 0

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:1171",
                            "message": "after update_key_metrics()",
                            "data": {"metrics_updated": metrics_updated},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "G",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        # Check for termination signal before final steps
        if _terminating:
            logger.warning("⚠️  Termination signal received, marking as failed")
            await recorder.fail("Job terminated before completion")
            return False  # Return False to indicate incomplete

        # Final summary
        duration = time.time() - start_time
        logger.info("\n" + "=" * 60)
        logger.info("🎉 SYNC COMPLETE")
        logger.info("=" * 60)
        logger.info(f"📊 Shorts records updated: {shorts_updated:,}")
        logger.info(f"💰 Price records updated: {prices_updated:,}")
        if SYNC_KEY_METRICS:
            logger.info(f"📈 Key metrics updated: {metrics_updated:,}")
        logger.info(f"⏱️  Duration: {duration:.1f} seconds")
        logger.info("=" * 60)

        # Data health check
        try:
            health = await check_data_health(conn)
            logger.info("")
            logger.info("📋 DATA HEALTH CHECK")
            logger.info("-" * 40)
            logger.info(f"   Total stocks: {health['total_stocks']}")
            logger.info(f"   Complete (≥2000 records): {health['complete']}")
            logger.info(f"   Partial (500-2000): {health['partial']}")
            logger.info(f"   Incomplete (<500): {health['incomplete']}")
            logger.info(f"   Health score: {health['health_score']}%")

            if health["stale_stocks"]:
                logger.warning(
                    f"   ⚠️ {len(health['stale_stocks'])} stocks with stale data:"
                )
                for stock, last_date in health["stale_stocks"][:5]:
                    logger.warning(f"      - {stock}: last data {last_date}")
            else:
                logger.info("   ✅ No stale data detected")
            logger.info("-" * 40)
        except Exception as e:
            logger.warning(f"⚠️ Could not run health check: {e}")

        logger.info("🔍 DEBUG: After SYNC COMPLETE, before Algolia check")
        logger.info(
            f"🔍 DEBUG: SYNC_ALGOLIA env var = '{os.getenv('SYNC_ALGOLIA', 'NOT_SET')}'"
        )

        # Trigger Algolia sync if configured
        if os.getenv("SYNC_ALGOLIA", "").lower() == "true":
            try:
                logger.info("🔍 Triggering Algolia sync...")
                await trigger_algolia_sync()
                # Algolia sync doesn't return metrics in current implementation
                # We'll assume it started if no error raised
                await recorder.update_metric(
                    "algolia_records_synced", 0
                )  # Or update if we change trigger_algolia_sync to return count
            except Exception as e:
                logger.error(f"❌ Error triggering Algolia sync: {e}")
        else:
            logger.info("🔍 DEBUG: Algolia sync not enabled, skipping")

        logger.info("🔍 DEBUG: After Algolia check, before recorder.complete()")
        logger.info(f"🔍 DEBUG: recorder object exists: {recorder is not None}")
        logger.info(
            f"🔍 DEBUG: recorder.run_id: {recorder.run_id if recorder else 'N/A'}"
        )

        # Check if all stocks are processed (using integer counts now)
        processed_count = recorder.checkpoint_data["stocks_processed"]
        all_complete = processed_count >= total_stocks

        logger.info("📝 About to call recorder.complete()...")
        logger.info(f"📊 Progress: {processed_count}/{total_stocks} stocks processed")
        logger.info(
            f"✅ Successful: {recorder.checkpoint_data['stocks_successful']}"
        )
        logger.info(f"❌ Failed: {recorder.checkpoint_data['stocks_failed']}")

        try:
            await recorder.complete(all_stocks_complete=all_complete)
            if all_complete:
                logger.info(
                    "✅ recorder.complete() finished successfully - all stocks processed"
                )
            else:
                remaining = total_stocks - processed_count
                logger.info(
                    f"⏸️  recorder.complete() finished - partial completion ({processed_count}/{total_stocks})"
                )
                logger.info(
                    f"🔄 {remaining} stocks remaining - job marked as 'partial' for retry"
                )
        except Exception as e:
            logger.error(f"❌ Failed to call recorder.complete(): {e}")
            import traceback

            logger.error(traceback.format_exc())
            # Don't raise - we want to exit cleanly even if status update fails

        logger.info("🔍 DEBUG: After recorder.complete() call")
        logger.info("🔍 DEBUG: About to exit main() function normally")

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:1482",
                            "message": "after recorder.complete()",
                            "data": {"all_complete": all_complete},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "D",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        # Return partial completion status (will be checked in __main__)
        return all_complete

    except Exception as e:
        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:934",
                            "message": "exception caught",
                            "data": {"error": str(e), "type": type(e).__name__},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "E",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        logger.error(f"\n❌ SYNC FAILED: {e}")

        # Re-raise to trigger Cloud Run retry
        raise

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:936",
                            "message": "before recorder.fail()",
                            "data": {"error": str(e)},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "E",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        await recorder.fail(str(e))

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:938",
                            "message": "after recorder.fail(), before raise",
                            "data": {},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "E",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        raise

    finally:
        logger.info("🔍 DEBUG: Entering finally block")
        # Check if we were terminated and mark as failed before closing connection
        # Only update if we haven't already marked it as failed/completed
        if _terminating:
            logger.info("🔍 DEBUG: _terminating is True, checking status")
            try:
                # Check current status to avoid duplicate updates
                current_status = await conn.fetchval(
                    "SELECT status FROM sync_status WHERE run_id = $1", recorder.run_id
                )
                logger.info(f"🔍 DEBUG: Current status in DB: {current_status}")
                if current_status == "running":
                    logger.warning(
                        "⚠️  Job was terminated, marking as failed before cleanup"
                    )
                    await recorder.fail("Job terminated due to timeout")
            except Exception as e:
                logger.error(f"Failed to mark job as failed in finally block: {e}")
        else:
            logger.info("🔍 DEBUG: _terminating is False, normal completion")

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:940",
                            "message": "finally block, before conn.close()",
                            "data": {"_terminating": _terminating},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "F",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion

        logger.info("🔍 DEBUG: About to close database connection")
        await conn.close()
        logger.info("🔍 DEBUG: Database connection closed")

        # #region agent log
        try:
            with open(
                "/Users/benebsworth/projects/shorted/.cursor/debug.log", "a"
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "timestamp": time.time() * 1000,
                            "location": "comprehensive_daily_sync.py:942",
                            "message": "finally block, after conn.close()",
                            "data": {},
                            "sessionId": "debug-session",
                            "runId": "run1",
                            "hypothesisId": "F",
                        }
                    )
                    + "\n"
                )
        except:
            pass
        # #endregion


async def trigger_algolia_sync():
    """Trigger Algolia index sync via HTTP call or subprocess."""
    algolia_app_id = os.getenv("ALGOLIA_APP_ID")
    algolia_admin_key = os.getenv("ALGOLIA_ADMIN_KEY")

    if not algolia_app_id or not algolia_admin_key:
        logger.warning("⚠️  Algolia credentials not configured, skipping index sync")
        return

    logger.info("\n🔍 Triggering Algolia index sync...")

    # Option 1: Call the sync script directly (if Node.js available)
    import subprocess
    import shutil

    # Check if we're in a Cloud Run environment with the sync script
    sync_script = "/app/scripts/sync-search-index.sh"
    if os.path.exists(sync_script):
        try:
            result = subprocess.run(
                [sync_script],
                env={
                    **os.environ,
                    "DATABASE_URL": DATABASE_URL,
                    "ALGOLIA_APP_ID": algolia_app_id,
                    "ALGOLIA_ADMIN_KEY": algolia_admin_key,
                    "ALGOLIA_INDEX": os.getenv("ALGOLIA_INDEX", "stocks"),
                },
                capture_output=True,
                text=True,
                timeout=300,  # 5 minute timeout
            )
            if result.returncode == 0:
                logger.info("✅ Algolia sync completed successfully")
            else:
                logger.error(f"❌ Algolia sync failed: {result.stderr}")
        except subprocess.TimeoutExpired:
            logger.error("❌ Algolia sync timed out")
        except Exception as e:
            logger.error(f"❌ Algolia sync error: {e}")
    else:
        # Option 2: Make HTTP call to a Cloud Run service that handles sync
        algolia_sync_url = os.getenv("ALGOLIA_SYNC_URL")
        if algolia_sync_url:
            try:
                async with httpx.AsyncClient(timeout=300.0) as client:
                    response = await client.post(
                        algolia_sync_url,
                        headers={
                            "Authorization": f"Bearer {os.getenv('ALGOLIA_SYNC_TOKEN', '')}"
                        },
                    )
                    if response.status_code == 200:
                        logger.info("✅ Algolia sync triggered successfully")
                    else:
                        logger.error(f"❌ Algolia sync failed: {response.status_code}")
            except Exception as e:
                logger.error(f"❌ Algolia sync request failed: {e}")
        else:
            logger.info(
                "ℹ️  No Algolia sync mechanism configured (set ALGOLIA_SYNC_URL or include sync script)"
            )


if __name__ == "__main__":
    logger.info("🔍 DEBUG: Script starting, about to call asyncio.run(main())")
    all_complete = False
    try:
        result = asyncio.run(main())
        all_complete = result if result is not None else False
        logger.info(f"🔍 DEBUG: asyncio.run(main()) completed with result: {result}")

        # If not all stocks are complete, exit with code 2 to trigger retry
        # (Cloud Run will retry jobs that exit with non-zero codes)
        if not all_complete:
            logger.warning(
                "⚠️  Partial completion - exiting with code 2 to trigger retry"
            )
            sys.exit(2)
    except KeyboardInterrupt:
        logger.warning("⚠️  Interrupted by user")
        sys.exit(1)
    except Exception as e:
        logger.error(f"❌ Fatal error in main: {e}")
        import traceback

        logger.error(traceback.format_exc())
        sys.exit(1)
    finally:
        # Ensure we flush any pending logs
        import sys

        logger.info("🔍 DEBUG: In finally block of __main__, flushing logs")
        sys.stdout.flush()
        sys.stderr.flush()
        logger.info("🔍 DEBUG: Script exiting")
