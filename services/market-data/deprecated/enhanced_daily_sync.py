#!/usr/bin/env python3
"""
Enhanced daily sync with Alpha Vantage priority and Yahoo Finance fallback.

This script syncs recent stock prices using Alpha Vantage as the primary source
and falls back to Yahoo Finance if Alpha Vantage fails.
"""

import asyncio
import asyncpg
import os
import sys
import logging
from datetime import date, timedelta
from typing import Dict, List, Optional
import pandas as pd

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from data_providers.factory import DataProviderFactory
from data_providers.base import DataProviderError, RateLimitError, SymbolNotFoundError
from asx_stock_resolver import ASXStockResolver, DynamicASXProcessor

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Environment variables
DATABASE_URL = os.getenv("DATABASE_URL")
ALPHA_VANTAGE_API_KEY = os.environ["ALPHA_VANTAGE_API_KEY"]

if not DATABASE_URL:
    logger.error("❌ DATABASE_URL environment variable is required")
    sys.exit(1)

# Note: ASX stocks are now loaded dynamically from the comprehensive CSV file


class EnhancedDailySync:
    """Enhanced daily sync with Alpha Vantage priority and Yahoo Finance fallback."""

    def __init__(self, dynamic_processor: Optional[DynamicASXProcessor] = None):
        """
        Initialize the sync processor with both data providers and dynamic ASX support.

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

    async def fetch_recent_data_with_fallback(
        self, symbol: str, days_back: int = 5
    ) -> Optional[pd.DataFrame]:
        """
        Fetch recent stock data with Alpha Vantage priority and Yahoo Finance fallback.

        Args:
            symbol: Stock symbol (e.g., 'CBA' or 'CBA.AX')
            days_back: Number of days back to fetch

        Returns:
            DataFrame with recent data or None if both providers fail
        """
        # Validate the symbol first
        if not self.dynamic_processor.validate_stock_symbol(symbol):
            logger.error(f"❌ Invalid ASX symbol: {symbol}")
            return None

        # Resolve symbols for both providers
        alpha_symbol, yahoo_symbol = (
            self.dynamic_processor.resolve_symbols_for_providers(symbol)
        )

        start_date = date.today() - timedelta(days=days_back)
        end_date = date.today()

        # Try Alpha Vantage first
        if self.alpha_vantage_provider:
            try:
                logger.debug(
                    f"🔄 Trying Alpha Vantage for {symbol} ({alpha_symbol})..."
                )
                async with self.alpha_vantage_provider as provider:
                    df = await provider.fetch_historical_data(
                        alpha_symbol, start_date, end_date
                    )

                    if df is not None and not df.empty:
                        logger.debug(
                            f"✅ Alpha Vantage success for {symbol}: {len(df)} records"
                        )
                        return df
                    else:
                        logger.debug(f"⚠️ Alpha Vantage returned no data for {symbol}")

            except (DataProviderError, RateLimitError, SymbolNotFoundError) as e:
                logger.debug(f"⚠️ Alpha Vantage failed for {symbol}: {e}")
            except Exception as e:
                logger.debug(f"❌ Alpha Vantage unexpected error for {symbol}: {e}")

        # Fallback to Yahoo Finance
        if self.yahoo_provider:
            try:
                logger.debug(
                    f"🔄 Falling back to Yahoo Finance for {symbol} ({yahoo_symbol})..."
                )
                df = await self.yahoo_provider.fetch_historical_data(
                    yahoo_symbol, start_date, end_date
                )

                if df is not None and not df.empty:
                    logger.debug(
                        f"✅ Yahoo Finance success for {symbol}: {len(df)} records"
                    )
                    return df
                else:
                    logger.debug(f"⚠️ Yahoo Finance returned no data for {symbol}")

            except Exception as e:
                logger.debug(f"❌ Yahoo Finance failed for {symbol}: {e}")

        logger.warning(f"❌ Both providers failed for {symbol}")
        return None

    async def sync_stock(
        self, conn: asyncpg.Connection, stock_code: str, days_back: int = 5
    ) -> int:
        """
        Sync a single stock's recent data using enhanced processor.

        Args:
            conn: Database connection
            stock_code: Stock code (e.g., 'CBA')
            days_back: Number of days back to sync

        Returns:
            Number of records inserted/updated
        """
        try:
            logger.info(f"📈 Syncing {stock_code}...")

            # Fetch recent data using enhanced processor
            df = await self.fetch_recent_data_with_fallback(stock_code, days_back)

            if df is None or df.empty:
                logger.warning(f"⚠️ No data for {stock_code}")
                return 0

            inserted = 0
            for date_idx, row in df.iterrows():
                if row.isna().any():
                    continue

                trading_date = (
                    date_idx.date() if hasattr(date_idx, "date") else date_idx
                )

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
                        trading_date,
                        round(float(row["Open"]), 2),
                        round(float(row["High"]), 2),
                        round(float(row["Low"]), 2),
                        round(float(row["Close"]), 2),
                        round(float(row["Close"]), 2),
                        int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
                    )
                    inserted += 1
                except Exception as e:
                    logger.warning(f"⚠️ Error inserting {trading_date}: {e}")

            logger.info(f"✅ {inserted} records for {stock_code}")
            return inserted

        except Exception as e:
            logger.error(f"❌ Error syncing {stock_code}: {e}")
            return 0

    async def run_daily_sync(self, days_back: int = 5, limit: Optional[int] = None):
        """
        Run the enhanced daily sync process.

        Args:
            days_back: Number of days back to sync
            limit: Maximum number of stocks to sync (None for all)
        """
        # Get stocks to sync
        if limit:
            stocks_to_sync = self.dynamic_processor.get_top_stocks(limit)
        else:
            stocks_to_sync = sorted(list(self.dynamic_processor.get_available_stocks()))

        logger.info("🚀 Starting enhanced daily stock price sync")
        logger.info(f"📊 Syncing {len(stocks_to_sync)} stocks")
        logger.info(f"📅 Fetching last {days_back} days of data")
        logger.info(f"🔄 Using Alpha Vantage priority with Yahoo Finance fallback")
        logger.info(f"🎯 Processing {'top ' + str(limit) if limit else 'all'} stocks\n")

        conn = await asyncpg.connect(DATABASE_URL)

        try:
            total_inserted = 0
            successful_stocks = 0

            for i, stock_code in enumerate(stocks_to_sync, 1):
                logger.info(f"[{i:2d}/{len(stocks_to_sync)}] Processing {stock_code}")

                inserted = await self.sync_stock(conn, stock_code, days_back)
                total_inserted += inserted

                if inserted > 0:
                    successful_stocks += 1

                # Rate limiting - be respectful to APIs
                if i < len(stocks_to_sync):
                    await asyncio.sleep(1)  # Shorter delay for daily sync

            logger.info(f"\n🎉 Enhanced sync complete!")
            logger.info(f"📈 Total records: {total_inserted}")
            logger.info(
                f"✅ Successful stocks: {successful_stocks}/{len(stocks_to_sync)}"
            )

        except Exception as e:
            logger.error(f"❌ Error during sync: {e}")
            raise
        finally:
            await conn.close()


async def main():
    """Main function to run the enhanced daily sync."""
    sync_processor = EnhancedDailySync()

    # Sync top 100 stocks by market cap for daily sync
    # Change limit=None to sync all ASX stocks (warning: this will take a very long time!)
    await sync_processor.run_daily_sync(days_back=5, limit=100)


if __name__ == "__main__":
    asyncio.run(main())
