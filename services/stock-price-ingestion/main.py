#!/usr/bin/env python3
"""
Stock Price Data Ingestion Service
Fetches historical stock price data from various sources and stores in PostgreSQL
"""

import os
import sys
import logging
import asyncio
import asyncpg
from datetime import datetime, timedelta, date
from typing import List, Dict, Optional, Tuple
import aiohttp
import pandas as pd
import yfinance as yf
from uuid import uuid4
import json
from dataclasses import dataclass, asdict
import backoff
from circuit_breaker import CircuitBreaker, CircuitBreakerConfig
from data_validation import DataValidator

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


@dataclass
class StockPrice:
    stock_code: str
    date: date
    open: Optional[float]
    high: Optional[float]
    low: Optional[float]
    close: float
    adjusted_close: Optional[float]
    volume: Optional[int]


@dataclass
class DataQualityIssue:
    stock_code: str
    date: date
    data_source: str
    is_complete: bool
    missing_fields: List[str]
    anomaly_detected: bool
    anomaly_details: Optional[Dict]


class StockDataIngestion:
    def __init__(self, db_url: str):
        self.db_url = db_url
        self.pool: Optional[asyncpg.Pool] = None
        self.batch_id = str(uuid4())
        self.data_source = "yfinance"  # Can be extended to other sources
        # Initialize circuit breaker with custom config
        self.circuit_breaker = CircuitBreaker(
            CircuitBreakerConfig(
                failure_threshold=5, recovery_timeout=60, half_open_max_calls=3
            )
        )
        # Initialize data validator
        self.validator = DataValidator()

    async def init_db(self):
        """Initialize database connection pool"""
        self.pool = await asyncpg.create_pool(self.db_url, min_size=5, max_size=20)

    async def close_db(self):
        """Close database connection pool"""
        if self.pool:
            await self.pool.close()

    async def log_ingestion_start(
        self, start_date: date, end_date: date, stocks: List[str]
    ):
        """Log the start of an ingestion batch"""
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO stock_data_ingestion_log 
                (batch_id, data_source, start_date, end_date, stocks_processed, started_at, status)
                VALUES ($1, $2, $3, $4, $5, $6, 'running')
            """,
                self.batch_id,
                self.data_source,
                start_date,
                end_date,
                len(stocks),
                datetime.now(),
            )

    async def log_ingestion_complete(
        self,
        records_inserted: int,
        records_updated: int,
        errors: int,
        error_details: Optional[Dict] = None,
    ):
        """Log the completion of an ingestion batch"""
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE stock_data_ingestion_log 
                SET records_inserted = $1, records_updated = $2, errors = $3, 
                    error_details = $4, completed_at = $5, status = $6
                WHERE batch_id = $7
            """,
                records_inserted,
                records_updated,
                errors,
                json.dumps(error_details) if error_details else None,
                datetime.now(),
                "completed" if errors == 0 else "completed_with_errors",
                self.batch_id,
            )

    async def _fetch_from_yfinance(
        self, symbol: str, start_date: date, end_date: date
    ) -> pd.DataFrame:
        """Internal method to fetch data from yfinance"""
        loop = asyncio.get_event_loop()
        ticker = await loop.run_in_executor(None, yf.Ticker, symbol)

        df = await loop.run_in_executor(
            None,
            ticker.history,
            start=start_date,
            end=end_date,
            interval="1d",
            auto_adjust=False,
        )

        return df

    async def fetch_stock_data_yfinance(
        self, stock_code: str, start_date: date, end_date: date
    ) -> pd.DataFrame:
        """Fetch stock data from Yahoo Finance with circuit breaker protection"""
        # Add .AX suffix for ASX stocks
        symbol = f"{stock_code}.AX" if not stock_code.endswith(".AX") else stock_code

        try:
            # Use circuit breaker to protect external API call
            df = await self.circuit_breaker.call(
                self._fetch_from_yfinance, symbol, start_date, end_date
            )

            if df.empty:
                logger.warning(
                    f"No data found for {stock_code} between {start_date} and {end_date}"
                )
                return pd.DataFrame()

            # Reset index to get date as a column
            df.reset_index(inplace=True)
            df["stock_code"] = stock_code

            # Rename columns to match our schema
            df.rename(
                columns={
                    "Date": "date",
                    "Open": "open",
                    "High": "high",
                    "Low": "low",
                    "Close": "close",
                    "Adj Close": "adjusted_close",
                    "Volume": "volume",
                },
                inplace=True,
            )

            return df

        except Exception as e:
            if "Circuit breaker is OPEN" in str(e):
                logger.error(
                    f"Circuit breaker is open - too many failures fetching stock data"
                )
            else:
                logger.error(f"Error fetching data for {stock_code}: {str(e)}")
            raise

    def check_data_quality(
        self, df: pd.DataFrame, stock_code: str
    ) -> List[DataQualityIssue]:
        """Check data quality and identify issues"""
        issues = []

        for _, row in df.iterrows():
            missing_fields = []
            anomaly_detected = False
            anomaly_details = {}

            # Check for missing required fields
            if pd.isna(row["close"]):
                missing_fields.append("close")

            # Check for missing optional fields
            for field in ["open", "high", "low", "volume"]:
                if pd.isna(row[field]):
                    missing_fields.append(field)

            # Check for price anomalies
            if not pd.isna(row["high"]) and not pd.isna(row["low"]):
                if row["high"] < row["low"]:
                    anomaly_detected = True
                    anomaly_details["high_less_than_low"] = True

                # Check for extreme price movements (>20% in a day)
                if not pd.isna(row["open"]) and row["open"] > 0:
                    price_change = abs((row["close"] - row["open"]) / row["open"])
                    if price_change > 0.2:
                        anomaly_detected = True
                        anomaly_details["extreme_price_movement"] = (
                            f"{price_change*100:.1f}%"
                        )

            # Check for zero or negative prices
            for field in ["open", "high", "low", "close"]:
                if not pd.isna(row[field]) and row[field] <= 0:
                    anomaly_detected = True
                    anomaly_details[f"{field}_non_positive"] = row[field]

            if missing_fields or anomaly_detected:
                issues.append(
                    DataQualityIssue(
                        stock_code=stock_code,
                        date=(
                            row["date"].date()
                            if isinstance(row["date"], pd.Timestamp)
                            else row["date"]
                        ),
                        data_source=self.data_source,
                        is_complete=len(missing_fields) == 0,
                        missing_fields=missing_fields,
                        anomaly_detected=anomaly_detected,
                        anomaly_details=anomaly_details if anomaly_details else None,
                    )
                )

        return issues

    async def fetch_stock_data(
        self, symbol: str, start_date: date, end_date: date
    ) -> pd.DataFrame:
        """Fetch stock data for a symbol within date range"""
        return await self._fetch_from_yfinance(symbol, start_date, end_date)

    async def insert_stock_prices(
        self, df: pd.DataFrame, symbol: str = None
    ) -> Dict[str, int]:
        """Insert stock prices into database, returning dict with inserted/updated counts"""
        if df.empty:
            return {"inserted": 0, "updated": 0}

        inserted = 0
        updated = 0

        async with self.pool.acquire() as conn:
            for _, row in df.iterrows():
                try:
                    # Try to insert, update on conflict
                    result = await conn.execute(
                        """
                        INSERT INTO stock_prices 
                        (stock_code, date, open, high, low, close, adjusted_close, volume)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        ON CONFLICT (stock_code, date) 
                        DO UPDATE SET
                            open = EXCLUDED.open,
                            high = EXCLUDED.high,
                            low = EXCLUDED.low,
                            close = EXCLUDED.close,
                            adjusted_close = EXCLUDED.adjusted_close,
                            volume = EXCLUDED.volume,
                            updated_at = CURRENT_TIMESTAMP
                        RETURNING (xmax = 0) AS inserted
                    """,
                        row["stock_code"],
                        (
                            row["date"].date()
                            if isinstance(row["date"], pd.Timestamp)
                            else row["date"]
                        ),
                        float(row["open"]) if not pd.isna(row["open"]) else None,
                        float(row["high"]) if not pd.isna(row["high"]) else None,
                        float(row["low"]) if not pd.isna(row["low"]) else None,
                        float(row["close"]),
                        (
                            float(row["adjusted_close"])
                            if not pd.isna(row["adjusted_close"])
                            else None
                        ),
                        int(row["volume"]) if not pd.isna(row["volume"]) else None,
                    )

                    if result[0]["inserted"]:
                        inserted += 1
                    else:
                        updated += 1

                except Exception as e:
                    logger.error(f"Error inserting price data: {str(e)}")

        return {"inserted": inserted, "updated": updated}

    async def insert_quality_issues(self, issues: List[DataQualityIssue]):
        """Insert data quality issues into database"""
        if not issues:
            return

        async with self.pool.acquire() as conn:
            for issue in issues:
                try:
                    await conn.execute(
                        """
                        INSERT INTO stock_data_quality 
                        (stock_code, date, data_source, is_complete, missing_fields, 
                         anomaly_detected, anomaly_details)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (stock_code, date, data_source) DO NOTHING
                    """,
                        issue.stock_code,
                        issue.date,
                        issue.data_source,
                        issue.is_complete,
                        issue.missing_fields,
                        issue.anomaly_detected,
                        (
                            json.dumps(issue.anomaly_details)
                            if issue.anomaly_details
                            else None
                        ),
                    )
                except Exception as e:
                    logger.error(f"Error inserting quality issue: {str(e)}")

    async def ingest_stock_data(
        self, stock_codes: List[str], start_date: date, end_date: date
    ):
        """Main ingestion process for multiple stocks"""
        await self.log_ingestion_start(start_date, end_date, stock_codes)

        total_inserted = 0
        total_updated = 0
        total_errors = 0
        error_details = {}

        for stock_code in stock_codes:
            try:
                logger.info(f"Processing {stock_code}...")

                # Fetch data
                df = await self.fetch_stock_data_yfinance(
                    stock_code, start_date, end_date
                )

                if not df.empty:
                    # Validate data using comprehensive validator
                    is_valid, validation_issues = self.validator.validate_price_data(
                        df, stock_code
                    )

                    if not is_valid:
                        logger.error(
                            f"Critical validation errors for {stock_code}, skipping insertion"
                        )
                        total_errors += 1
                        error_details[stock_code] = "Failed validation: " + str(
                            validation_issues
                        )
                        continue

                    # Check data quality (existing method for compatibility)
                    quality_issues = self.check_data_quality(df, stock_code)
                    if quality_issues:
                        await self.insert_quality_issues(quality_issues)
                        logger.warning(
                            f"Found {len(quality_issues)} quality issues for {stock_code}"
                        )

                    # Log validation warnings
                    warnings = [
                        i for i in validation_issues if i.get("severity") == "warning"
                    ]
                    if warnings:
                        logger.warning(
                            f"Validation warnings for {stock_code}: {len(warnings)} issues"
                        )

                    # Insert prices
                    inserted, updated = await self.insert_stock_prices(df)
                    total_inserted += inserted
                    total_updated += updated

                    logger.info(
                        f"Completed {stock_code}: {inserted} inserted, {updated} updated"
                    )
                else:
                    logger.warning(f"No data found for {stock_code}")

            except Exception as e:
                logger.error(f"Error processing {stock_code}: {str(e)}")
                total_errors += 1
                error_details[stock_code] = str(e)

        await self.log_ingestion_complete(
            total_inserted, total_updated, total_errors, error_details
        )

        # Log circuit breaker metrics
        cb_metrics = self.circuit_breaker.get_metrics()
        logger.info(
            f"Circuit breaker state: {cb_metrics['state']}, failures: {cb_metrics['failure_count']}"
        )

        logger.info(
            f"Ingestion complete: {total_inserted} inserted, {total_updated} updated, {total_errors} errors"
        )

    async def generate_validation_report(
        self, stock_codes: List[str], start_date: date, end_date: date
    ) -> str:
        """Generate a validation report for specified stocks without inserting data"""
        logger.info(f"Generating validation report for {len(stock_codes)} stocks")

        validation_results = {}

        for stock_code in stock_codes:
            try:
                df = await self.fetch_stock_data_yfinance(
                    stock_code, start_date, end_date
                )
                if not df.empty:
                    is_valid, issues = self.validator.validate_price_data(
                        df, stock_code
                    )
                    validation_results[stock_code] = (is_valid, issues)
                else:
                    validation_results[stock_code] = (
                        False,
                        [{"type": "no_data", "severity": "critical"}],
                    )
            except Exception as e:
                validation_results[stock_code] = (
                    False,
                    [{"type": "fetch_error", "error": str(e), "severity": "critical"}],
                )

        report = self.validator.generate_validation_report(validation_results)
        return report


def load_all_asx_stocks() -> List[str]:
    """Load all ASX stock codes from the official ASX company list"""
    import os
    from pathlib import Path

    # Try multiple possible paths for the CSV file
    possible_paths = [
        Path(__file__).parent.parent.parent
        / "analysis"
        / "data"
        / "ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv",
        Path(
            "/app/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv"
        ),  # Docker path
        Path(
            "../../analysis/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv"
        ),  # Relative path
    ]

    csv_path = None
    for path in possible_paths:
        if path.exists():
            csv_path = path
            break

    if not csv_path:
        logger.error(
            f"ASX companies CSV not found. Tried: {[str(p) for p in possible_paths]}"
        )
        logger.warning("Falling back to top 24 ASX stocks")
        return [
            "CBA",
            "BHP",
            "CSL",
            "WBC",
            "ANZ",
            "NAB",
            "WES",
            "MQG",
            "WOW",
            "TLS",
            "RIO",
            "WDS",
            "GMG",
            "TCL",
            "COL",
            "FMG",
            "REA",
            "ALL",
            "IAG",
            "SUN",
            "QBE",
            "JHX",
            "AMC",
            "BXB",
        ]

    try:
        df = pd.read_csv(csv_path, engine="python")

        if "ASX code" not in df.columns:
            logger.error("CSV missing 'ASX code' column")
            return []

        # Get all stock codes, clean and filter
        stock_codes = df["ASX code"].dropna().str.strip().str.upper().unique().tolist()

        # Filter out invalid codes (should be 3-4 letters)
        stock_codes = [
            code
            for code in stock_codes
            if len(code) >= 3 and len(code) <= 4 and code.isalpha()
        ]

        logger.info(f"Loaded {len(stock_codes)} ASX stocks from {csv_path}")
        return sorted(stock_codes)

    except Exception as e:
        logger.error(f"Error loading ASX stocks from CSV: {e}")
        return []


async def main():
    """Main entry point"""
    # Get database connection from environment
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise ValueError("DATABASE_URL environment variable is required")

    # Load ALL ASX stocks from official CSV
    stock_codes = load_all_asx_stocks()

    if not stock_codes:
        logger.error("No stock codes loaded, exiting")
        return

    logger.info(f"Processing {len(stock_codes)} ASX stocks")

    # Date range (last 2 years by default for daily sync, can be overridden)
    end_date = date.today()
    days_back = int(os.getenv("DAYS_BACK", "730"))  # Default 2 years
    start_date = end_date - timedelta(days=days_back)

    # Initialize ingestion
    ingestion = StockDataIngestion(db_url)

    try:
        await ingestion.init_db()
        await ingestion.ingest_stock_data(stock_codes, start_date, end_date)
    finally:
        await ingestion.close_db()


if __name__ == "__main__":
    asyncio.run(main())
