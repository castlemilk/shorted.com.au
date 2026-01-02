#!/usr/bin/env python3
"""
Comprehensive test suite for the enhanced ASX stock data processor with mocked API calls.

This test suite validates:
1. API call mocking and fallback logic
2. Data processing and transformation
3. Database operations with mocked connections
4. Error handling and resilience
5. Symbol resolution and validation
"""

import asyncio
import pytest
import pandas as pd
from datetime import date, timedelta
from unittest.mock import AsyncMock, MagicMock, patch
from typing import Dict, List, Optional
import logging

# Add the current directory to Python path
import sys
import os

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from asx_stock_resolver import ASXStockResolver, DynamicASXProcessor
from enhanced_historical_processor import EnhancedStockDataProcessor
from enhanced_daily_sync import EnhancedDailySync
from data_providers.base import DataProviderError, RateLimitError, SymbolNotFoundError

# Configure logging for tests
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)


class MockDataProvider:
    """Mock data provider for testing."""

    def __init__(
        self,
        provider_name: str,
        should_fail: bool = False,
        fail_with_rate_limit: bool = False,
    ):
        self.provider_name = provider_name
        self.should_fail = should_fail
        self.fail_with_rate_limit = fail_with_rate_limit
        self.call_count = 0

    def get_provider_name(self) -> str:
        return self.provider_name

    def get_rate_limit_delay(self) -> float:
        return 1.0

    def get_batch_size(self) -> int:
        return 10

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass

    async def fetch_historical_data(
        self, symbol: str, start_date: date, end_date: date
    ) -> Optional[pd.DataFrame]:
        """Mock fetch_historical_data with configurable behavior."""
        self.call_count += 1

        if self.should_fail:
            if self.fail_with_rate_limit:
                raise RateLimitError("Rate limit exceeded")
            else:
                raise DataProviderError(f"Mock error for {symbol}")

        # Return mock data
        dates = pd.date_range(start=start_date, end=end_date, freq="D")
        mock_data = []

        for i, d in enumerate(dates):
            if i < 5:  # Return some data
                mock_data.append(
                    {
                        "Open": 100.0 + i,
                        "High": 105.0 + i,
                        "Low": 95.0 + i,
                        "Close": 102.0 + i,
                        "Volume": 1000000 + i * 10000,
                    }
                )

        if not mock_data:
            return None

        df = pd.DataFrame(mock_data, index=dates[: len(mock_data)])
        df.index.name = "Date"
        return df


class TestASXStockResolver:
    """Test suite for ASX stock resolver."""

    def test_resolver_initialization(self):
        """Test resolver initialization with mock CSV."""
        with patch("pandas.read_csv") as mock_read_csv:
            mock_df = pd.DataFrame(
                {
                    "ASX code": ["CBA", "BHP", "CSL"],
                    "Company name": ["Commonwealth Bank", "BHP Group", "CSL Limited"],
                    "GICs industry group": ["Banks", "Mining", "Healthcare"],
                    "Listing date": ["1991-01-01", "1985-01-01", "1994-01-01"],
                    "Market Cap": [120000000000, 200000000000, 150000000000],
                }
            )
            mock_read_csv.return_value = mock_df

            resolver = ASXStockResolver()

            assert len(resolver.get_all_stock_symbols()) == 3
            assert "CBA" in resolver.get_all_stock_symbols()
            assert "BHP" in resolver.get_all_stock_symbols()

    def test_symbol_validation(self):
        """Test symbol validation logic."""
        resolver = ASXStockResolver()

        # Mock the stock symbols
        resolver.stock_symbols = {"CBA", "BHP", "CSL"}

        assert resolver.is_valid_asx_symbol("CBA") == True
        assert resolver.is_valid_asx_symbol("CBA.AX") == True
        assert resolver.is_valid_asx_symbol("INVALID") == False
        assert resolver.is_valid_asx_symbol("") == False

    def test_symbol_resolution(self):
        """Test symbol resolution for different providers."""
        resolver = ASXStockResolver()

        # Test Alpha Vantage resolution
        assert resolver.resolve_to_alpha_vantage("CBA") == "CBA"
        assert resolver.resolve_to_alpha_vantage("CBA.AX") == "CBA"

        # Test Yahoo Finance resolution
        assert resolver.resolve_to_yahoo_finance("CBA") == "CBA.AX"
        assert resolver.resolve_to_yahoo_finance("CBA.AX") == "CBA.AX"

    def test_stock_info_retrieval(self):
        """Test stock information retrieval."""
        with patch("pandas.read_csv") as mock_read_csv:
            mock_df = pd.DataFrame(
                {
                    "ASX code": ["CBA"],
                    "Company name": ["Commonwealth Bank"],
                    "GICs industry group": ["Banks"],
                    "Listing date": ["1991-01-01"],
                    "Market Cap": [120000000000],
                }
            )
            mock_read_csv.return_value = mock_df

            resolver = ASXStockResolver()
            stock_info = resolver.get_stock_info("CBA")

            assert stock_info is not None
            assert stock_info["symbol"] == "CBA"
            assert stock_info["company_name"] == "Commonwealth Bank"
            assert stock_info["industry"] == "Banks"

    def test_top_stocks_by_market_cap(self):
        """Test top stocks by market cap functionality."""
        with patch("pandas.read_csv") as mock_read_csv:
            mock_df = pd.DataFrame(
                {
                    "ASX code": ["CSL", "CBA", "BHP"],
                    "Company name": ["CSL Limited", "Commonwealth Bank", "BHP Group"],
                    "GICs industry group": ["Healthcare", "Banks", "Mining"],
                    "Listing date": ["1994-01-01", "1991-01-01", "1985-01-01"],
                    "Market Cap": [150000000000, 120000000000, 200000000000],
                }
            )
            mock_read_csv.return_value = mock_df

            resolver = ASXStockResolver()
            top_stocks = resolver.get_top_stocks_by_market_cap(2)

            assert len(top_stocks) == 2
            assert top_stocks[0] == "BHP"  # Highest market cap
            assert top_stocks[1] == "CSL"  # Second highest


class TestEnhancedStockDataProcessor:
    """Test suite for enhanced stock data processor with mocked APIs."""

    @pytest.fixture
    def mock_processor(self):
        """Create a processor with mocked providers."""
        processor = EnhancedStockDataProcessor()

        # Mock the providers
        processor.alpha_vantage_provider = MockDataProvider(
            "Alpha Vantage", should_fail=False
        )
        processor.yahoo_provider = MockDataProvider("Yahoo Finance", should_fail=False)

        # Mock the dynamic processor
        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        return processor

    @pytest.fixture
    def mock_processor_with_alpha_failure(self):
        """Create a processor where Alpha Vantage fails."""
        processor = EnhancedStockDataProcessor()

        # Alpha Vantage fails, Yahoo Finance succeeds
        processor.alpha_vantage_provider = MockDataProvider(
            "Alpha Vantage", should_fail=True
        )
        processor.yahoo_provider = MockDataProvider("Yahoo Finance", should_fail=False)

        # Mock the dynamic processor
        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        return processor

    @pytest.fixture
    def mock_processor_with_both_failures(self):
        """Create a processor where both providers fail."""
        processor = EnhancedStockDataProcessor()

        # Both providers fail
        processor.alpha_vantage_provider = MockDataProvider(
            "Alpha Vantage", should_fail=True
        )
        processor.yahoo_provider = MockDataProvider("Yahoo Finance", should_fail=True)

        # Mock the dynamic processor
        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        return processor

    @pytest.mark.asyncio
    async def test_successful_alpha_vantage_fetch(self, mock_processor):
        """Test successful data fetch from Alpha Vantage."""
        df = await mock_processor.fetch_stock_data_with_fallback("CBA", years=1)

        assert df is not None
        assert not df.empty
        assert len(df) == 5  # Mock returns 5 records
        assert "Open" in df.columns
        assert "Close" in df.columns

        # Verify Alpha Vantage was called
        assert mock_processor.alpha_vantage_provider.call_count == 1
        assert mock_processor.yahoo_provider.call_count == 0

    @pytest.mark.asyncio
    async def test_fallback_to_yahoo_finance(self, mock_processor_with_alpha_failure):
        """Test fallback to Yahoo Finance when Alpha Vantage fails."""
        df = await mock_processor_with_alpha_failure.fetch_stock_data_with_fallback(
            "CBA", years=1
        )

        assert df is not None
        assert not df.empty
        assert len(df) == 5

        # Verify both providers were called
        assert mock_processor_with_alpha_failure.alpha_vantage_provider.call_count == 1
        assert mock_processor_with_alpha_failure.yahoo_provider.call_count == 1

    @pytest.mark.asyncio
    async def test_both_providers_fail(self, mock_processor_with_both_failures):
        """Test behavior when both providers fail."""
        df = await mock_processor_with_both_failures.fetch_stock_data_with_fallback(
            "CBA", years=1
        )

        assert df is None

        # Verify both providers were called
        assert mock_processor_with_both_failures.alpha_vantage_provider.call_count == 1
        assert mock_processor_with_both_failures.yahoo_provider.call_count == 1

    @pytest.mark.asyncio
    async def test_invalid_symbol_handling(self, mock_processor):
        """Test handling of invalid symbols."""
        mock_processor.dynamic_processor.validate_stock_symbol.return_value = False

        df = await mock_processor.fetch_stock_data_with_fallback("INVALID", years=1)

        assert df is None
        # No providers should be called for invalid symbols
        assert mock_processor.alpha_vantage_provider.call_count == 0
        assert mock_processor.yahoo_provider.call_count == 0

    def test_dataframe_to_records_conversion(self, mock_processor):
        """Test conversion of DataFrame to database records."""
        # Create mock DataFrame
        dates = pd.date_range(start="2023-01-01", periods=3, freq="D")
        df = pd.DataFrame(
            {
                "Open": [100.0, 101.0, 102.0],
                "High": [105.0, 106.0, 107.0],
                "Low": [95.0, 96.0, 97.0],
                "Close": [102.0, 103.0, 104.0],
                "Volume": [1000000, 1100000, 1200000],
            },
            index=dates,
        )
        df.index.name = "Date"

        records = mock_processor.convert_dataframe_to_records(df, "CBA")

        assert len(records) == 3
        assert records[0]["stock_code"] == "CBA"
        assert records[0]["open"] == 100.0
        assert records[0]["close"] == 102.0
        assert records[0]["volume"] == 1000000

    def test_dataframe_to_records_with_nan_values(self, mock_processor):
        """Test conversion handles NaN values correctly."""
        # Create DataFrame with NaN values
        dates = pd.date_range(start="2023-01-01", periods=3, freq="D")
        df = pd.DataFrame(
            {
                "Open": [100.0, float("nan"), 102.0],
                "High": [105.0, 106.0, 107.0],
                "Low": [95.0, 96.0, 97.0],
                "Close": [102.0, float("nan"), 104.0],
                "Volume": [1000000, 1100000, 1200000],
            },
            index=dates,
        )
        df.index.name = "Date"

        records = mock_processor.convert_dataframe_to_records(df, "CBA")

        # Should skip rows with NaN values
        assert len(records) == 2  # Only 2 valid records

    @pytest.mark.asyncio
    async def test_rate_limit_error_handling(self):
        """Test handling of rate limit errors."""
        processor = EnhancedStockDataProcessor()

        # Create provider that fails with rate limit error
        processor.alpha_vantage_provider = MockDataProvider(
            "Alpha Vantage", should_fail=True, fail_with_rate_limit=True
        )
        processor.yahoo_provider = MockDataProvider("Yahoo Finance", should_fail=False)

        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        df = await processor.fetch_stock_data_with_fallback("CBA", years=1)

        # Should fallback to Yahoo Finance
        assert df is not None
        assert processor.alpha_vantage_provider.call_count == 1
        assert processor.yahoo_provider.call_count == 1


class TestDatabaseOperations:
    """Test suite for database operations with mocked connections."""

    @pytest.fixture
    def mock_connection(self):
        """Create a mocked database connection."""
        conn = AsyncMock()

        # Mock existing data check
        conn.fetchrow.return_value = {"count": 0, "earliest": None, "latest": None}

        # Mock execute for DELETE and INSERT
        conn.execute.return_value = None

        return conn

    @pytest.fixture
    def mock_connection_with_existing_data(self):
        """Create a mocked connection with existing data."""
        conn = AsyncMock()

        # Mock existing data check - has 3000 records (should skip)
        conn.fetchrow.return_value = {
            "count": 3000,
            "earliest": date(2020, 1, 1),
            "latest": date(2023, 12, 31),
        }

        return conn

    @pytest.mark.asyncio
    async def test_update_stock_with_no_existing_data(self, mock_connection):
        """Test updating stock when no existing data."""
        processor = EnhancedStockDataProcessor()

        # Mock the data fetch
        processor.fetch_stock_data_with_fallback = AsyncMock()
        processor.fetch_stock_data_with_fallback.return_value = pd.DataFrame(
            {
                "Open": [100.0, 101.0],
                "High": [105.0, 106.0],
                "Low": [95.0, 96.0],
                "Close": [102.0, 103.0],
                "Volume": [1000000, 1100000],
            },
            index=pd.date_range("2023-01-01", periods=2),
        )

        processor.convert_dataframe_to_records = MagicMock()
        processor.convert_dataframe_to_records.return_value = [
            {
                "stock_code": "CBA",
                "date": date(2023, 1, 1),
                "open": 100.0,
                "high": 105.0,
                "low": 95.0,
                "close": 102.0,
                "adjusted_close": 102.0,
                "volume": 1000000,
            },
            {
                "stock_code": "CBA",
                "date": date(2023, 1, 2),
                "open": 101.0,
                "high": 106.0,
                "low": 96.0,
                "close": 103.0,
                "adjusted_close": 103.0,
                "volume": 1100000,
            },
        ]

        inserted = await processor.update_stock_in_database(
            mock_connection, "CBA", years=1
        )

        assert inserted == 2
        assert mock_connection.execute.call_count == 3  # DELETE + 2 INSERTs

    @pytest.mark.asyncio
    async def test_update_stock_with_existing_data(
        self, mock_connection_with_existing_data
    ):
        """Test updating stock when existing data should be skipped."""
        processor = EnhancedStockDataProcessor()

        inserted = await processor.update_stock_in_database(
            mock_connection_with_existing_data, "CBA", years=1
        )

        # Should return existing count and not insert new data
        assert inserted == 3000
        # Should not call execute for DELETE/INSERT
        assert mock_connection_with_existing_data.execute.call_count == 0

    @pytest.mark.asyncio
    async def test_update_stock_with_no_data_available(self, mock_connection):
        """Test updating stock when no data is available."""
        processor = EnhancedStockDataProcessor()

        # Mock the data fetch to return None
        processor.fetch_stock_data_with_fallback = AsyncMock()
        processor.fetch_stock_data_with_fallback.return_value = None

        inserted = await processor.update_stock_in_database(
            mock_connection, "CBA", years=1
        )

        assert inserted == 0
        # Should not call execute for DELETE/INSERT
        assert mock_connection.execute.call_count == 0

    @pytest.mark.asyncio
    async def test_database_insert_error_handling(self, mock_connection):
        """Test handling of database insert errors."""
        processor = EnhancedStockDataProcessor()

        # Mock the data fetch
        processor.fetch_stock_data_with_fallback = AsyncMock()
        processor.fetch_stock_data_with_fallback.return_value = pd.DataFrame(
            {
                "Open": [100.0],
                "High": [105.0],
                "Low": [95.0],
                "Close": [102.0],
                "Volume": [1000000],
            },
            index=pd.date_range("2023-01-01", periods=1),
        )

        processor.convert_dataframe_to_records = MagicMock()
        processor.convert_dataframe_to_records.return_value = [
            {
                "stock_code": "CBA",
                "date": date(2023, 1, 1),
                "open": 100.0,
                "high": 105.0,
                "low": 95.0,
                "close": 102.0,
                "adjusted_close": 102.0,
                "volume": 1000000,
            }
        ]

        # Mock execute to raise an error on the second call (INSERT)
        mock_connection.execute.side_effect = [None, Exception("Database error")]

        inserted = await processor.update_stock_in_database(
            mock_connection, "CBA", years=1
        )

        # Should handle the error gracefully and return 0
        assert inserted == 0


class TestEnhancedDailySync:
    """Test suite for enhanced daily sync with mocked APIs."""

    @pytest.fixture
    def mock_sync_processor(self):
        """Create a sync processor with mocked providers."""
        processor = EnhancedDailySync()

        # Mock the providers
        processor.alpha_vantage_provider = MockDataProvider(
            "Alpha Vantage", should_fail=False
        )
        processor.yahoo_provider = MockDataProvider("Yahoo Finance", should_fail=False)

        # Mock the dynamic processor
        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )
        processor.dynamic_processor.get_top_stocks.return_value = ["CBA", "BHP"]
        processor.dynamic_processor.get_available_stocks.return_value = {
            "CBA",
            "BHP",
            "CSL",
        }

        return processor

    @pytest.fixture
    def mock_connection(self):
        """Create a mocked database connection."""
        conn = AsyncMock()
        conn.execute.return_value = None
        return conn

    @pytest.mark.asyncio
    async def test_sync_stock_success(self, mock_sync_processor, mock_connection):
        """Test successful stock sync."""
        inserted = await mock_sync_processor.sync_stock(
            mock_connection, "CBA", days_back=5
        )

        assert inserted == 5  # Mock returns 5 records
        assert mock_connection.execute.call_count == 5  # 5 INSERTs

    @pytest.mark.asyncio
    async def test_sync_stock_with_fallback(self, mock_connection):
        """Test stock sync with fallback to Yahoo Finance."""
        processor = EnhancedDailySync()

        # Alpha Vantage fails, Yahoo Finance succeeds
        processor.alpha_vantage_provider = MockDataProvider(
            "Alpha Vantage", should_fail=True
        )
        processor.yahoo_provider = MockDataProvider("Yahoo Finance", should_fail=False)

        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        inserted = await processor.sync_stock(mock_connection, "CBA", days_back=5)

        assert inserted == 5
        assert processor.alpha_vantage_provider.call_count == 1
        assert processor.yahoo_provider.call_count == 1

    @pytest.mark.asyncio
    async def test_sync_stock_no_data(self, mock_connection):
        """Test stock sync when no data is available."""
        processor = EnhancedDailySync()

        # Both providers fail
        processor.alpha_vantage_provider = MockDataProvider(
            "Alpha Vantage", should_fail=True
        )
        processor.yahoo_provider = MockDataProvider("Yahoo Finance", should_fail=True)

        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        inserted = await processor.sync_stock(mock_connection, "CBA", days_back=5)

        assert inserted == 0
        assert mock_connection.execute.call_count == 0

    @pytest.mark.asyncio
    async def test_run_daily_sync_with_limit(self, mock_sync_processor):
        """Test running daily sync with limit."""
        with patch("asyncpg.connect") as mock_connect:
            mock_conn = AsyncMock()
            mock_conn.execute.return_value = None
            mock_connect.return_value = mock_conn

            await mock_sync_processor.run_daily_sync(days_back=5, limit=2)

            # Should process 2 stocks
            assert mock_conn.execute.call_count == 10  # 2 stocks * 5 records each


class TestResilienceAndErrorHandling:
    """Test suite for resilience and error handling."""

    @pytest.mark.asyncio
    async def test_concurrent_api_calls(self):
        """Test handling of concurrent API calls."""
        processor = EnhancedStockDataProcessor()

        # Mock providers that simulate network delays
        processor.alpha_vantage_provider = MockDataProvider(
            "Alpha Vantage", should_fail=False
        )
        processor.yahoo_provider = MockDataProvider("Yahoo Finance", should_fail=False)

        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        # Test concurrent calls
        tasks = [
            processor.fetch_stock_data_with_fallback("CBA", years=1),
            processor.fetch_stock_data_with_fallback("BHP", years=1),
            processor.fetch_stock_data_with_fallback("CSL", years=1),
        ]

        results = await asyncio.gather(*tasks)

        # All should succeed
        assert all(df is not None for df in results)
        assert all(not df.empty for df in results)

    @pytest.mark.asyncio
    async def test_partial_failure_recovery(self):
        """Test recovery from partial failures."""
        processor = EnhancedStockDataProcessor()

        # Create a provider that fails on first call, succeeds on second
        class FailingThenSucceedingProvider:
            def __init__(self):
                self.call_count = 0

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            async def fetch_historical_data(self, symbol, start_date, end_date):
                self.call_count += 1
                if self.call_count == 1:
                    raise DataProviderError("Temporary failure")

                # Return success data
                dates = pd.date_range(start=start_date, end=end_date, freq="D")
                return pd.DataFrame(
                    {
                        "Open": [100.0],
                        "High": [105.0],
                        "Low": [95.0],
                        "Close": [102.0],
                        "Volume": [1000000],
                    },
                    index=dates[:1],
                )

        processor.alpha_vantage_provider = FailingThenSucceedingProvider()
        processor.yahoo_provider = MockDataProvider("Yahoo Finance", should_fail=False)

        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        # First call should fail and fallback to Yahoo
        df1 = await processor.fetch_stock_data_with_fallback("CBA", years=1)
        assert df1 is not None

        # Second call should succeed with Alpha Vantage
        df2 = await processor.fetch_stock_data_with_fallback("CBA", years=1)
        assert df2 is not None


if __name__ == "__main__":
    # Run the tests
    pytest.main([__file__, "-v", "--tb=short"])
