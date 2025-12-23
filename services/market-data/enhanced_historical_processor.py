#!/usr/bin/env python3
"""
Enhanced historical stock data processor with Alpha Vantage priority and Yahoo Finance fallback.

This script uses Alpha Vantage as the primary data source and falls back to Yahoo Finance
if Alpha Vantage fails or returns no data. It supports ALL ASX stocks dynamically.
"""

import asyncio
import asyncpg
import os
import sys
import logging
from datetime import date, timedelta
from typing import Dict, List, Optional, Set
import pandas as pd

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from data_providers.factory import DataProviderFactory
from data_providers.base import DataProviderError, RateLimitError, SymbolNotFoundError
from asx_stock_resolver import ASXStockResolver, DynamicASXProcessor
from gap_detector import find_gaps

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Environment variables
DATABASE_URL = os.getenv("DATABASE_URL")
ALPHA_VANTAGE_API_KEY = os.getenv("ALPHA_VANTAGE_API_KEY", "UOI9AM59F03A0WZC")

if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")


class EnhancedStockDataProcessor:
    """Enhanced processor with Alpha Vantage priority and Yahoo Finance fallback."""

    def __init__(self, dynamic_processor: Optional[DynamicASXProcessor] = None):
        """
        Initialize the processor with both data providers and dynamic ASX support.

        Args:
            dynamic_processor: Dynamic ASX processor instance. If None, creates a new one.
        """
        self.dynamic_processor = dynamic_processor or DynamicASXProcessor()
        self.alpha_vantage_provider = None
        self.yahoo_provider = None
        self._initialize_providers()

    def _initialize_providers(self):
        """Initialize both data providers."""
        try:
            # Initialize Alpha Vantage provider
            self.alpha_vantage_provider = DataProviderFactory.create_provider(
                "alpha_vantage", api_key=ALPHA_VANTAGE_API_KEY
            )
            logger.info(
                f"✅ Alpha Vantage provider initialized: {self.alpha_vantage_provider.get_provider_name()}"
            )
        except Exception as e:
            logger.warning(f"⚠️ Failed to initialize Alpha Vantage provider: {e}")
            self.alpha_vantage_provider = None

        try:
            # Initialize Yahoo Finance provider
            self.yahoo_provider = DataProviderFactory.create_provider("yahoo_finance")
            logger.info(
                f"✅ Yahoo Finance provider initialized: {self.yahoo_provider.get_provider_name()}"
            )
        except Exception as e:
            logger.error(f"❌ Failed to initialize Yahoo Finance provider: {e}")
            self.yahoo_provider = None

    async def fetch_stock_data_with_fallback(
        self, symbol: str, years: int = 10, skip_validation: bool = False
    ) -> Optional[pd.DataFrame]:
        """
        Fetch stock data with Alpha Vantage priority and Yahoo Finance fallback.

        Args:
            symbol: Stock symbol (e.g., 'CBA' or 'CBA.AX')
            years: Number of years of historical data to fetch
            skip_validation: Skip symbol validation (useful for repair operations)

        Returns:
            DataFrame with historical data or None if both providers fail
        """
        # Validate the symbol first (unless skipped for repair operations)
        if not skip_validation and not self.dynamic_processor.validate_stock_symbol(symbol):
            logger.warning(f"⚠️ Symbol {symbol} not in resolver's stock list, attempting fetch anyway")

        # Normalize symbol for provider resolution
        # Remove .AX suffix for internal processing, add it back for Yahoo
        base_symbol = symbol.replace('.AX', '').upper()
        alpha_symbol = base_symbol
        yahoo_symbol = f"{base_symbol}.AX"
        
        # Try to use the resolver if the symbol is known
        if self.dynamic_processor.validate_stock_symbol(symbol):
            alpha_symbol, yahoo_symbol = (
                self.dynamic_processor.resolve_symbols_for_providers(symbol)
            )

        start_date = date.today() - timedelta(days=years * 365)
        end_date = date.today()
        
        # Calculate minimum expected records (~250 trading days/year, allow 80% coverage)
        min_expected_records = int(years * 250 * 0.8)

        alpha_df = None
        # Try Alpha Vantage first
        if self.alpha_vantage_provider:
            try:
                logger.info(f"🔄 Trying Alpha Vantage for {symbol} ({alpha_symbol})...")
                async with self.alpha_vantage_provider as provider:
                    alpha_df = await provider.fetch_historical_data(
                        alpha_symbol, start_date, end_date, full_output=True
                    )

                    if alpha_df is not None and not alpha_df.empty:
                        logger.info(
                            f"✅ Alpha Vantage returned {len(alpha_df)} records for {symbol}"
                        )
                        # Check if we have sufficient data
                        if len(alpha_df) >= min_expected_records:
                            logger.info(f"✅ Alpha Vantage data sufficient for {symbol}")
                            return alpha_df
                        else:
                            logger.warning(
                                f"⚠️ Alpha Vantage returned insufficient data for {symbol}: "
                                f"{len(alpha_df)} records (expected at least {min_expected_records})"
                            )
                    else:
                        logger.warning(f"⚠️ Alpha Vantage returned no data for {symbol}")

            except (DataProviderError, RateLimitError, SymbolNotFoundError) as e:
                logger.warning(f"⚠️ Alpha Vantage failed for {symbol}: {e}")
            except Exception as e:
                logger.error(f"❌ Alpha Vantage unexpected error for {symbol}: {e}")

        # Fallback to Yahoo Finance (or use if Alpha Vantage data was insufficient)
        if self.yahoo_provider:
            try:
                logger.info(
                    f"🔄 Trying Yahoo Finance for {symbol} ({yahoo_symbol})..."
                )
                yahoo_df = await self.yahoo_provider.fetch_historical_data(
                    yahoo_symbol, start_date, end_date
                )

                if yahoo_df is not None and not yahoo_df.empty:
                    logger.info(
                        f"✅ Yahoo Finance returned {len(yahoo_df)} records for {symbol}"
                    )
                    # If we have Alpha Vantage data too, use whichever has more
                    if alpha_df is not None and len(alpha_df) > len(yahoo_df):
                        logger.info(f"📊 Using Alpha Vantage data (more records)")
                        return alpha_df
                    return yahoo_df
                else:
                    logger.warning(f"⚠️ Yahoo Finance returned no data for {symbol}")

            except Exception as e:
                logger.error(f"❌ Yahoo Finance failed for {symbol}: {e}")

        # If we have partial Alpha Vantage data, use it as a last resort
        if alpha_df is not None and not alpha_df.empty:
            logger.warning(f"⚠️ Using partial Alpha Vantage data ({len(alpha_df)} records) for {symbol}")
            return alpha_df

        logger.error(f"❌ Both providers failed for {symbol}")
        return None

    def convert_dataframe_to_records(
        self, df: pd.DataFrame, stock_code: str
    ) -> List[Dict]:
        """
        Convert DataFrame to list of database records.

        Args:
            df: DataFrame with historical data
            stock_code: Stock code for the records

        Returns:
            List of database record dictionaries
        """
        records = []

        for date_idx, row in df.iterrows():
            # Skip rows with NaN values
            if pd.isna(row["Open"]) or pd.isna(row["Close"]):
                continue

            trading_date = date_idx.date() if hasattr(date_idx, "date") else date_idx

            records.append(
                {
                    "stock_code": stock_code,
                    "date": trading_date,
                    "open": round(float(row["Open"]), 2),
                    "high": round(float(row["High"]), 2),
                    "low": round(float(row["Low"]), 2),
                    "close": round(float(row["Close"]), 2),
                    "adjusted_close": round(
                        float(row["Close"]), 2
                    ),  # Assuming already adjusted
                    "volume": int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
                }
            )

        return records

    async def update_stock_in_database(
        self, conn: asyncpg.Connection, stock_code: str, years: int = 10
    ) -> int:
        """
        Update a single stock with historical data using enhanced processor.

        Args:
            conn: Database connection
            stock_code: Stock code (e.g., 'CBA')
            years: Number of years of data to fetch

        Returns:
            Number of records inserted
        """
        # Check if stock already has data
        existing = await conn.fetchrow(
            """
            SELECT COUNT(*) as count, MIN(date) as earliest, MAX(date) as latest
            FROM stock_prices WHERE stock_code = $1
            """,
            stock_code,
        )

        # Check for gaps if data exists
        has_gaps = False
        if existing["count"] > 0:
            actual_dates = [row["date"] for row in await conn.fetch(
                "SELECT date FROM stock_prices WHERE stock_code = $1 ORDER BY date ASC",
                stock_code
            )]
            gap_ranges = find_gaps(actual_dates, start_date=existing["earliest"], end_date=existing["latest"])
            if gap_ranges:
                has_gaps = True
                logger.info(f"🔍 Found {len(gap_ranges)} gaps for {stock_code}")

        # Skip only if we have recent data, enough records, and no gaps
        is_recent = existing["latest"] and (date.today() - existing["latest"]).days < 7
        if existing["count"] > 2000 and is_recent and not has_gaps:
            years_existing = (
                (existing["latest"] - existing["earliest"]).days / 365.25
                if existing["earliest"]
                else 0
            )
            logger.info(
                f"⏭️ Skipping {stock_code} - already has {existing['count']:,} records ({years_existing:.1f} years) and no gaps"
            )
            return existing["count"]

        # Fetch data using enhanced processor
        # Skip validation since we're repairing a stock that exists in our database
        logger.info(f"📈 Fetching {years} years of data for {stock_code}...")
        df = await self.fetch_stock_data_with_fallback(stock_code, years, skip_validation=True)

        if df is None or df.empty:
            logger.warning(f"⚠️ No data available for {stock_code}")
            return 0

        # Convert to database records
        records = self.convert_dataframe_to_records(df, stock_code)

        if not records:
            logger.warning(f"⚠️ No valid records after processing for {stock_code}")
            return 0

        logger.info(f"📊 Processing {len(records)} records for {stock_code}")
        logger.info(f"📅 Date range: {records[0]['date']} to {records[-1]['date']}")

        # Insert new data using UPSERT pattern to avoid data loss and preserve existing data
        inserted = 0
        batch_size = 100

        for i in range(0, len(records), batch_size):
            batch = records[i : i + batch_size]

            for record in batch:
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
                        record["stock_code"],
                        record["date"],
                        record["open"],
                        record["high"],
                        record["low"],
                        record["close"],
                        record["adjusted_close"],
                        record["volume"],
                    )
                    inserted += 1
                except Exception as e:
                    logger.warning(f"⚠️ Insert error for {record['date']}: {e}")
                    continue

        logger.info(f"✅ Upserted {inserted}/{len(records)} records for {stock_code}")
        return inserted

    async def populate_all_stocks(self, years: int = 10, limit: Optional[int] = None):
        """
        Populate all stocks with historical data using enhanced processor.

        Args:
            years: Number of years of historical data to fetch
            limit: Maximum number of stocks to process (None for all)
        """
        # Get all available ASX stocks
        all_stocks = self.dynamic_processor.get_available_stocks()

        if limit:
            # Get top stocks by market cap if limit is specified
            top_stocks = self.dynamic_processor.get_top_stocks(limit)
            stocks_to_process = top_stocks
        else:
            stocks_to_process = sorted(list(all_stocks))

        logger.info(
            f"🚀 Starting enhanced population of {len(stocks_to_process)} ASX stocks"
        )
        logger.info(f"📊 Using Alpha Vantage priority with Yahoo Finance fallback")
        logger.info(f"📅 Fetching {years} years of historical data")
        logger.info(f"🎯 Processing {'top ' + str(limit) if limit else 'all'} stocks\n")

        conn = await asyncpg.connect(DATABASE_URL)

        try:
            total_inserted = 0
            successful_stocks = 0

            for i, stock_code in enumerate(stocks_to_process, 1):
                logger.info(
                    f"[{i:2d}/{len(stocks_to_process)}] Processing {stock_code}"
                )

                inserted = await self.update_stock_in_database(conn, stock_code, years)

                if inserted >= 0:
                    total_inserted += inserted
                    successful_stocks += 1

                # Rate limiting - be respectful to APIs
                if i < len(stocks_to_process):
                    logger.debug("⏳ Waiting for rate limiting...")
                    await asyncio.sleep(2)

                logger.info("")  # Empty line for readability

            # Final summary
            await self._print_final_summary(
                conn, successful_stocks, total_inserted, len(stocks_to_process)
            )

        except Exception as e:
            logger.error(f"❌ Error during population: {e}")
            raise
        finally:
            await conn.close()

    async def _print_final_summary(
        self,
        conn: asyncpg.Connection,
        successful_stocks: int,
        total_inserted: int,
        total_stocks: int,
    ):
        """Print final summary of the population process."""
        final_stats = await conn.fetch(
            """
            SELECT stock_code, COUNT(*) as records, MIN(date) as earliest, MAX(date) as latest
            FROM stock_prices 
            GROUP BY stock_code 
            ORDER BY stock_code
            """
        )

        total_records = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")
        overall_range = await conn.fetchrow(
            """
            SELECT MIN(date) as earliest, MAX(date) as latest FROM stock_prices
            """
        )

        logger.info("🎉 Enhanced population completed!")
        logger.info(f"📊 Total database records: {total_records:,}")
        logger.info(
            f"📅 Overall date range: {overall_range['earliest']} to {overall_range['latest']}"
        )
        logger.info(
            f"✅ Successfully processed: {successful_stocks}/{total_stocks} stocks"
        )
        logger.info(f"➕ Records inserted: {total_inserted:,}")

        logger.info(f"\n📈 Final stock summary:")
        logger.info("Stock | Records | Earliest   | Latest     | Years")
        logger.info("------+---------+------------+------------+------")

        for row in final_stats:
            if row["earliest"] and row["latest"]:
                years_existing = (row["latest"] - row["earliest"]).days / 365.25
                logger.info(
                    f"{row['stock_code']:<5} | {row['records']:>7,} | {row['earliest']} | {row['latest']} | {years_existing:>4.1f}"
                )
            else:
                logger.info(
                    f"{row['stock_code']:<5} | {row['records']:>7,} | {'N/A':<10} | {'N/A':<10} | {'N/A':>4}"
                )

        # Show total years of data available
        total_data_years = sum(
            (row["latest"] - row["earliest"]).days / 365.25
            for row in final_stats
            if row["earliest"] and row["latest"]
        )

        logger.info(
            f"\n📊 Total years of historical data: {total_data_years:.1f} years"
        )
        logger.info(
            f"📈 Average years per stock: {total_data_years / len(final_stats):.1f} years"
        )


async def main():
    """Main function to run the enhanced processor."""
    processor = EnhancedStockDataProcessor()

    # Process top 50 stocks by market cap for initial run
    # Change limit=None to process all ASX stocks (warning: this will take a very long time!)
    await processor.populate_all_stocks(years=10, limit=50)


if __name__ == "__main__":
    asyncio.run(main())
