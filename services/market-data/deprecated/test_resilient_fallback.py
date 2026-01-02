#!/usr/bin/env python3
"""
Resilient fallback logic tests for the enhanced ASX stock data processor.

This test suite specifically focuses on:
1. Alpha Vantage API failure scenarios and Yahoo Finance fallback
2. Rate limiting handling and retry logic
3. Network timeout and connection error handling
4. Data quality validation and error recovery
5. Concurrent request handling with fallbacks
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

from enhanced_historical_processor import EnhancedStockDataProcessor
from enhanced_daily_sync import EnhancedDailySync
from data_providers.base import DataProviderError, RateLimitError, SymbolNotFoundError

# Configure logging for tests
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)


class ResilientMockProvider:
    """Mock provider that can simulate various failure scenarios."""

    def __init__(self, provider_name: str, failure_scenario: str = "none"):
        self.provider_name = provider_name
        self.failure_scenario = failure_scenario
        self.call_count = 0
        self.call_history = []

    def get_provider_name(self) -> str:
        return self.provider_name

    def get_rate_limit_delay(self) -> float:
        return 1.0 if self.provider_name == "Alpha Vantage" else 0.5

    def get_batch_size(self) -> int:
        return 10

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass

    async def fetch_historical_data(
        self, symbol: str, start_date: date, end_date: date
    ) -> Optional[pd.DataFrame]:
        """Simulate various failure scenarios."""
        self.call_count += 1
        self.call_history.append(
            {
                "symbol": symbol,
                "start_date": start_date,
                "end_date": end_date,
                "call_number": self.call_count,
            }
        )

        if self.failure_scenario == "rate_limit":
            raise RateLimitError(f"Rate limit exceeded for {symbol}")

        elif self.failure_scenario == "network_error":
            raise DataProviderError(f"Network error for {symbol}")

        elif self.failure_scenario == "symbol_not_found":
            raise SymbolNotFoundError(f"Symbol {symbol} not found")

        elif self.failure_scenario == "empty_data":
            return None

        elif self.failure_scenario == "partial_data":
            # Return partial data (only 2 records instead of expected 5)
            dates = pd.date_range(start=start_date, end=end_date, freq="D")[:2]
            return pd.DataFrame(
                {
                    "Open": [100.0, 101.0],
                    "High": [105.0, 106.0],
                    "Low": [95.0, 96.0],
                    "Close": [102.0, 103.0],
                    "Volume": [1000000, 1100000],
                },
                index=dates,
            )

        elif self.failure_scenario == "corrupted_data":
            # Return data with NaN values
            dates = pd.date_range(start=start_date, end=end_date, freq="D")[:3]
            return pd.DataFrame(
                {
                    "Open": [100.0, float("nan"), 102.0],
                    "High": [105.0, 106.0, 107.0],
                    "Low": [95.0, 96.0, 97.0],
                    "Close": [102.0, float("nan"), 104.0],
                    "Volume": [1000000, 1100000, 1200000],
                },
                index=dates,
            )

        elif self.failure_scenario == "slow_response":
            # Simulate slow response
            await asyncio.sleep(0.1)
            dates = pd.date_range(start=start_date, end=end_date, freq="D")[:5]
            return pd.DataFrame(
                {
                    "Open": [100.0 + i for i in range(5)],
                    "High": [105.0 + i for i in range(5)],
                    "Low": [95.0 + i for i in range(5)],
                    "Close": [102.0 + i for i in range(5)],
                    "Volume": [1000000 + i * 10000 for i in range(5)],
                },
                index=dates,
            )

        else:  # success
            dates = pd.date_range(start=start_date, end=end_date, freq="D")[:5]
            return pd.DataFrame(
                {
                    "Open": [100.0 + i for i in range(5)],
                    "High": [105.0 + i for i in range(5)],
                    "Low": [95.0 + i for i in range(5)],
                    "Close": [102.0 + i for i in range(5)],
                    "Volume": [1000000 + i * 10000 for i in range(5)],
                },
                index=dates,
            )


class TestResilientFallbackLogic:
    """Test suite for resilient fallback logic."""

    @pytest.fixture
    def processor_with_fallback(self):
        """Create processor with fallback capability."""
        processor = EnhancedStockDataProcessor()

        # Mock the dynamic processor
        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        return processor

    @pytest.mark.asyncio
    async def test_alpha_vantage_rate_limit_fallback(self, processor_with_fallback):
        """Test fallback when Alpha Vantage hits rate limit."""
        processor_with_fallback.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "rate_limit"
        )
        processor_with_fallback.yahoo_provider = ResilientMockProvider(
            "Yahoo Finance", "none"
        )

        df = await processor_with_fallback.fetch_stock_data_with_fallback(
            "CBA", years=1
        )

        # Should succeed via Yahoo Finance fallback
        assert df is not None
        assert not df.empty
        assert processor_with_fallback.alpha_vantage_provider.call_count == 1
        assert processor_with_fallback.yahoo_provider.call_count == 1

    @pytest.mark.asyncio
    async def test_alpha_vantage_network_error_fallback(self, processor_with_fallback):
        """Test fallback when Alpha Vantage has network error."""
        processor_with_fallback.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "network_error"
        )
        processor_with_fallback.yahoo_provider = ResilientMockProvider(
            "Yahoo Finance", "none"
        )

        df = await processor_with_fallback.fetch_stock_data_with_fallback(
            "CBA", years=1
        )

        # Should succeed via Yahoo Finance fallback
        assert df is not None
        assert not df.empty
        assert processor_with_fallback.alpha_vantage_provider.call_count == 1
        assert processor_with_fallback.yahoo_provider.call_count == 1

    @pytest.mark.asyncio
    async def test_alpha_vantage_symbol_not_found_fallback(
        self, processor_with_fallback
    ):
        """Test fallback when Alpha Vantage doesn't find symbol."""
        processor_with_fallback.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "symbol_not_found"
        )
        processor_with_fallback.yahoo_provider = ResilientMockProvider(
            "Yahoo Finance", "none"
        )

        df = await processor_with_fallback.fetch_stock_data_with_fallback(
            "CBA", years=1
        )

        # Should succeed via Yahoo Finance fallback
        assert df is not None
        assert not df.empty
        assert processor_with_fallback.alpha_vantage_provider.call_count == 1
        assert processor_with_fallback.yahoo_provider.call_count == 1

    @pytest.mark.asyncio
    async def test_alpha_vantage_empty_data_fallback(self, processor_with_fallback):
        """Test fallback when Alpha Vantage returns empty data."""
        processor_with_fallback.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "empty_data"
        )
        processor_with_fallback.yahoo_provider = ResilientMockProvider(
            "Yahoo Finance", "none"
        )

        df = await processor_with_fallback.fetch_stock_data_with_fallback(
            "CBA", years=1
        )

        # Should succeed via Yahoo Finance fallback
        assert df is not None
        assert not df.empty
        assert processor_with_fallback.alpha_vantage_provider.call_count == 1
        assert processor_with_fallback.yahoo_provider.call_count == 1

    @pytest.mark.asyncio
    async def test_both_providers_fail(self, processor_with_fallback):
        """Test behavior when both providers fail."""
        processor_with_fallback.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "network_error"
        )
        processor_with_fallback.yahoo_provider = ResilientMockProvider(
            "Yahoo Finance", "network_error"
        )

        df = await processor_with_fallback.fetch_stock_data_with_fallback(
            "CBA", years=1
        )

        # Should return None when both fail
        assert df is None
        assert processor_with_fallback.alpha_vantage_provider.call_count == 1
        assert processor_with_fallback.yahoo_provider.call_count == 1

    @pytest.mark.asyncio
    async def test_yahoo_finance_rate_limit_handling(self, processor_with_fallback):
        """Test handling when Yahoo Finance hits rate limit."""
        processor_with_fallback.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "network_error"
        )
        processor_with_fallback.yahoo_provider = ResilientMockProvider(
            "Yahoo Finance", "rate_limit"
        )

        df = await processor_with_fallback.fetch_stock_data_with_fallback(
            "CBA", years=1
        )

        # Should return None when both fail
        assert df is None
        assert processor_with_fallback.alpha_vantage_provider.call_count == 1
        assert processor_with_fallback.yahoo_provider.call_count == 1

    @pytest.mark.asyncio
    async def test_partial_data_handling(self, processor_with_fallback):
        """Test handling of partial data from providers."""
        processor_with_fallback.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "partial_data"
        )
        processor_with_fallback.yahoo_provider = ResilientMockProvider(
            "Yahoo Finance", "none"
        )

        df = await processor_with_fallback.fetch_stock_data_with_fallback(
            "CBA", years=1
        )

        # Should accept partial data from Alpha Vantage
        assert df is not None
        assert len(df) == 2  # Partial data
        assert processor_with_fallback.alpha_vantage_provider.call_count == 1
        assert processor_with_fallback.yahoo_provider.call_count == 0

    @pytest.mark.asyncio
    async def test_corrupted_data_fallback(self, processor_with_fallback):
        """Test fallback when provider returns corrupted data."""
        processor_with_fallback.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "corrupted_data"
        )
        processor_with_fallback.yahoo_provider = ResilientMockProvider(
            "Yahoo Finance", "none"
        )

        df = await processor_with_fallback.fetch_stock_data_with_fallback(
            "CBA", years=1
        )

        # Should accept corrupted data and clean it
        assert df is not None
        assert len(df) == 3  # Original data
        assert processor_with_fallback.alpha_vantage_provider.call_count == 1
        assert processor_with_fallback.yahoo_provider.call_count == 0

        # Test that corrupted data is cleaned in conversion
        records = processor_with_fallback.convert_dataframe_to_records(df, "CBA")
        assert len(records) == 2  # Should skip NaN rows

    @pytest.mark.asyncio
    async def test_slow_response_handling(self, processor_with_fallback):
        """Test handling of slow API responses."""
        processor_with_fallback.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "slow_response"
        )
        processor_with_fallback.yahoo_provider = ResilientMockProvider(
            "Yahoo Finance", "none"
        )

        start_time = asyncio.get_event_loop().time()
        df = await processor_with_fallback.fetch_stock_data_with_fallback(
            "CBA", years=1
        )
        end_time = asyncio.get_event_loop().time()

        # Should succeed despite slow response
        assert df is not None
        assert not df.empty
        assert processor_with_fallback.alpha_vantage_provider.call_count == 1
        assert processor_with_fallback.yahoo_provider.call_count == 0

        # Should take at least 0.1 seconds due to slow response
        assert end_time - start_time >= 0.1


class TestConcurrentFallbackHandling:
    """Test suite for concurrent request handling with fallbacks."""

    @pytest.mark.asyncio
    async def test_concurrent_requests_with_mixed_failures(self):
        """Test concurrent requests with mixed success/failure scenarios."""
        processor = EnhancedStockDataProcessor()

        # Mock the dynamic processor
        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True

        # Create tasks with different failure scenarios
        tasks = []

        # Task 1: Alpha Vantage fails, Yahoo succeeds
        processor1 = EnhancedStockDataProcessor()
        processor1.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "network_error"
        )
        processor1.yahoo_provider = ResilientMockProvider("Yahoo Finance", "none")
        processor1.dynamic_processor = MagicMock()
        processor1.dynamic_processor.validate_stock_symbol.return_value = True
        processor1.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )
        tasks.append(processor1.fetch_stock_data_with_fallback("CBA", years=1))

        # Task 2: Alpha Vantage succeeds
        processor2 = EnhancedStockDataProcessor()
        processor2.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "none"
        )
        processor2.yahoo_provider = ResilientMockProvider("Yahoo Finance", "none")
        processor2.dynamic_processor = MagicMock()
        processor2.dynamic_processor.validate_stock_symbol.return_value = True
        processor2.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "BHP",
            "BHP.AX",
        )
        tasks.append(processor2.fetch_stock_data_with_fallback("BHP", years=1))

        # Task 3: Both fail
        processor3 = EnhancedStockDataProcessor()
        processor3.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "network_error"
        )
        processor3.yahoo_provider = ResilientMockProvider(
            "Yahoo Finance", "network_error"
        )
        processor3.dynamic_processor = MagicMock()
        processor3.dynamic_processor.validate_stock_symbol.return_value = True
        processor3.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CSL",
            "CSL.AX",
        )
        tasks.append(processor3.fetch_stock_data_with_fallback("CSL", years=1))

        # Execute all tasks concurrently
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Check results
        assert results[0] is not None  # CBA should succeed via Yahoo fallback
        assert results[1] is not None  # BHP should succeed via Alpha Vantage
        assert results[2] is None  # CSL should fail (both providers fail)

        # Verify call counts
        assert processor1.alpha_vantage_provider.call_count == 1
        assert processor1.yahoo_provider.call_count == 1
        assert processor2.alpha_vantage_provider.call_count == 1
        assert processor2.yahoo_provider.call_count == 0
        assert processor3.alpha_vantage_provider.call_count == 1
        assert processor3.yahoo_provider.call_count == 1

    @pytest.mark.asyncio
    async def test_rate_limit_recovery(self):
        """Test recovery from rate limit errors."""
        processor = EnhancedStockDataProcessor()

        # Create a provider that fails with rate limit on first call, succeeds on second
        class RateLimitRecoveryProvider:
            def __init__(self):
                self.call_count = 0

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            async def fetch_historical_data(self, symbol, start_date, end_date):
                self.call_count += 1
                if self.call_count == 1:
                    raise RateLimitError("Rate limit exceeded")

                # Return success data on second call
                dates = pd.date_range(start=start_date, end=end_date, freq="D")[:5]
                return pd.DataFrame(
                    {
                        "Open": [100.0 + i for i in range(5)],
                        "High": [105.0 + i for i in range(5)],
                        "Low": [95.0 + i for i in range(5)],
                        "Close": [102.0 + i for i in range(5)],
                        "Volume": [1000000 + i * 10000 for i in range(5)],
                    },
                    index=dates,
                )

        processor.alpha_vantage_provider = RateLimitRecoveryProvider()
        processor.yahoo_provider = ResilientMockProvider("Yahoo Finance", "none")

        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        # First call should fail with rate limit and fallback to Yahoo
        df1 = await processor.fetch_stock_data_with_fallback("CBA", years=1)
        assert df1 is not None
        assert processor.alpha_vantage_provider.call_count == 1
        assert processor.yahoo_provider.call_count == 1

        # Second call should succeed with Alpha Vantage (rate limit recovered)
        df2 = await processor.fetch_stock_data_with_fallback("CBA", years=1)
        assert df2 is not None
        assert processor.alpha_vantage_provider.call_count == 2
        assert processor.yahoo_provider.call_count == 1  # Should not be called again


class TestDataQualityAndValidation:
    """Test suite for data quality validation and error recovery."""

    @pytest.mark.asyncio
    async def test_data_validation_and_cleaning(self):
        """Test data validation and cleaning logic."""
        processor = EnhancedStockDataProcessor()

        # Mock provider that returns data with various quality issues
        processor.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "corrupted_data"
        )
        processor.yahoo_provider = ResilientMockProvider("Yahoo Finance", "none")

        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        df = await processor.fetch_stock_data_with_fallback("CBA", years=1)

        assert df is not None

        # Test record conversion with data cleaning
        records = processor.convert_dataframe_to_records(df, "CBA")

        # Should clean out NaN values
        assert len(records) == 2  # Only 2 valid records (skipped NaN)

        # Verify data types and ranges
        for record in records:
            assert isinstance(record["open"], float)
            assert isinstance(record["close"], float)
            assert isinstance(record["volume"], int)
            assert record["open"] > 0
            assert record["close"] > 0
            assert record["volume"] >= 0

    @pytest.mark.asyncio
    async def test_empty_data_handling(self):
        """Test handling of completely empty data."""
        processor = EnhancedStockDataProcessor()

        processor.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "empty_data"
        )
        processor.yahoo_provider = ResilientMockProvider("Yahoo Finance", "empty_data")

        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        df = await processor.fetch_stock_data_with_fallback("CBA", years=1)

        # Should return None when both providers return empty data
        assert df is None

    @pytest.mark.asyncio
    async def test_invalid_symbol_handling(self):
        """Test handling of invalid symbols."""
        processor = EnhancedStockDataProcessor()

        processor.alpha_vantage_provider = ResilientMockProvider(
            "Alpha Vantage", "none"
        )
        processor.yahoo_provider = ResilientMockProvider("Yahoo Finance", "none")

        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = (
            False  # Invalid symbol
        )

        df = await processor.fetch_stock_data_with_fallback("INVALID", years=1)

        # Should return None for invalid symbols
        assert df is None
        # No providers should be called
        assert processor.alpha_vantage_provider.call_count == 0
        assert processor.yahoo_provider.call_count == 0


if __name__ == "__main__":
    # Run the tests
    pytest.main([__file__, "-v", "--tb=short"])
