#!/usr/bin/env python3
"""
Test configuration and utilities for the enhanced ASX stock data processor.

This module provides:
1. Test configuration and fixtures
2. Mock database setup
3. Test data generators
4. Utility functions for testing
"""

import asyncio
import os
import sys
from datetime import date, timedelta
from typing import Dict, List, Optional
import pandas as pd
import numpy as np
import asyncpg
from unittest.mock import AsyncMock, MagicMock

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from asx_stock_resolver import ASXStockResolver, DynamicASXProcessor
from enhanced_historical_processor import EnhancedStockDataProcessor
from enhanced_daily_sync import EnhancedDailySync


class TestConfig:
    """Test configuration constants."""

    # Test database URL (use in-memory or test database)
    TEST_DATABASE_URL = os.getenv(
        "TEST_DATABASE_URL", "postgresql://test:test@localhost:5432/test_shorted"
    )

    # Test API keys
    TEST_ALPHA_VANTAGE_API_KEY = "TEST_API_KEY"

    # Test symbols
    TEST_SYMBOLS = ["CBA", "BHP", "CSL", "WBC", "ANZ"]

    # Test date ranges
    TEST_START_DATE = date(2023, 1, 1)
    TEST_END_DATE = date(2023, 12, 31)


class MockDatabase:
    """Mock database for testing."""

    def __init__(self):
        self.records = {}
        self.call_count = 0

    async def connect(self):
        """Mock connection."""
        return self

    async def close(self):
        """Mock close."""
        pass

    async def fetchrow(self, query: str, *args):
        """Mock fetchrow."""
        self.call_count += 1

        if "COUNT(*)" in query and "stock_prices" in query:
            stock_code = args[0] if args else None
            if stock_code in self.records:
                count = len(self.records[stock_code])
                return {
                    "count": count,
                    "earliest": (
                        min(self.records[stock_code].keys()) if count > 0 else None
                    ),
                    "latest": (
                        max(self.records[stock_code].keys()) if count > 0 else None
                    ),
                }
            else:
                return {"count": 0, "earliest": None, "latest": None}

        return None

    async def fetchval(self, query: str, *args):
        """Mock fetchval."""
        self.call_count += 1

        if "COUNT(*)" in query and "stock_prices" in query:
            total = sum(len(records) for records in self.records.values())
            return total

        return 0

    async def fetch(self, query: str, *args):
        """Mock fetch."""
        self.call_count += 1

        if "GROUP BY stock_code" in query:
            results = []
            for stock_code, records in self.records.items():
                if records:
                    results.append(
                        {
                            "stock_code": stock_code,
                            "records": len(records),
                            "earliest": min(records.keys()),
                            "latest": max(records.keys()),
                        }
                    )
            return results

        return []

    async def execute(self, query: str, *args):
        """Mock execute."""
        self.call_count += 1

        if "DELETE FROM stock_prices" in query:
            stock_code = args[0]
            if stock_code in self.records:
                del self.records[stock_code]

        elif "INSERT INTO stock_prices" in query:
            stock_code = args[0]
            record_date = args[1]

            if stock_code not in self.records:
                self.records[stock_code] = {}

            self.records[stock_code][record_date] = {
                "open": args[2],
                "high": args[3],
                "low": args[4],
                "close": args[5],
                "adjusted_close": args[6],
                "volume": args[7],
            }


class TestDataGenerator:
    """Generate test data for various scenarios."""

    @staticmethod
    def generate_stock_data(
        symbol: str, days: int = 30, start_price: float = 100.0
    ) -> pd.DataFrame:
        """Generate realistic stock data for testing."""
        dates = pd.date_range(
            start=date.today() - timedelta(days=days), periods=days, freq="D"
        )

        data = []
        current_price = start_price

        for i, d in enumerate(dates):
            # Simulate realistic price movement
            volatility = 0.02  # 2% daily volatility
            change = (np.random.random() - 0.5) * volatility * current_price

            open_price = current_price
            close_price = current_price + change
            high_price = max(open_price, close_price) + abs(change) * 0.5
            low_price = min(open_price, close_price) - abs(change) * 0.5
            volume = int(1000000 + np.random.random() * 500000)

            data.append(
                {
                    "Open": round(open_price, 2),
                    "High": round(high_price, 2),
                    "Low": round(low_price, 2),
                    "Close": round(close_price, 2),
                    "Volume": volume,
                }
            )

            current_price = close_price

        df = pd.DataFrame(data, index=dates)
        df.index.name = "Date"
        return df

    @staticmethod
    def generate_corrupted_data(symbol: str, days: int = 10) -> pd.DataFrame:
        """Generate data with various quality issues."""
        dates = pd.date_range(
            start=date.today() - timedelta(days=days), periods=days, freq="D"
        )

        data = []
        for i, d in enumerate(dates):
            if i % 3 == 0:  # Every third record has issues
                data.append(
                    {
                        "Open": float("nan"),
                        "High": 105.0 + i,
                        "Low": 95.0 + i,
                        "Close": float("nan"),
                        "Volume": 1000000 + i * 10000,
                    }
                )
            else:
                data.append(
                    {
                        "Open": 100.0 + i,
                        "High": 105.0 + i,
                        "Low": 95.0 + i,
                        "Close": 102.0 + i,
                        "Volume": 1000000 + i * 10000,
                    }
                )

        df = pd.DataFrame(data, index=dates)
        df.index.name = "Date"
        return df

    @staticmethod
    def generate_empty_data() -> pd.DataFrame:
        """Generate empty DataFrame."""
        return pd.DataFrame()


class TestFixtures:
    """Test fixtures for common test scenarios."""

    @staticmethod
    def create_mock_processor_with_success():
        """Create processor with successful providers."""
        processor = EnhancedStockDataProcessor()

        # Mock successful providers
        processor.alpha_vantage_provider = MagicMock()
        processor.alpha_vantage_provider.get_provider_name.return_value = (
            "Alpha Vantage"
        )
        processor.alpha_vantage_provider.get_rate_limit_delay.return_value = 1.0
        processor.alpha_vantage_provider.get_batch_size.return_value = 10

        processor.yahoo_provider = MagicMock()
        processor.yahoo_provider.get_provider_name.return_value = "Yahoo Finance"
        processor.yahoo_provider.get_rate_limit_delay.return_value = 0.5
        processor.yahoo_provider.get_batch_size.return_value = 20

        # Mock dynamic processor
        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        return processor

    @staticmethod
    def create_mock_processor_with_alpha_failure():
        """Create processor where Alpha Vantage fails."""
        processor = EnhancedStockDataProcessor()

        # Mock failing Alpha Vantage provider
        processor.alpha_vantage_provider = MagicMock()
        processor.alpha_vantage_provider.get_provider_name.return_value = (
            "Alpha Vantage"
        )
        processor.alpha_vantage_provider.get_rate_limit_delay.return_value = 1.0
        processor.alpha_vantage_provider.get_batch_size.return_value = 10

        # Mock successful Yahoo Finance provider
        processor.yahoo_provider = MagicMock()
        processor.yahoo_provider.get_provider_name.return_value = "Yahoo Finance"
        processor.yahoo_provider.get_rate_limit_delay.return_value = 0.5
        processor.yahoo_provider.get_batch_size.return_value = 20

        # Mock dynamic processor
        processor.dynamic_processor = MagicMock()
        processor.dynamic_processor.validate_stock_symbol.return_value = True
        processor.dynamic_processor.resolve_symbols_for_providers.return_value = (
            "CBA",
            "CBA.AX",
        )

        return processor

    @staticmethod
    def create_mock_sync_processor():
        """Create sync processor with mocked providers."""
        processor = EnhancedDailySync()

        # Mock providers
        processor.alpha_vantage_provider = MagicMock()
        processor.alpha_vantage_provider.get_provider_name.return_value = (
            "Alpha Vantage"
        )

        processor.yahoo_provider = MagicMock()
        processor.yahoo_provider.get_provider_name.return_value = "Yahoo Finance"

        # Mock dynamic processor
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


class TestUtilities:
    """Utility functions for testing."""

    @staticmethod
    def assert_dataframe_quality(df: pd.DataFrame, expected_columns: List[str] = None):
        """Assert DataFrame meets quality standards."""
        if expected_columns is None:
            expected_columns = ["Open", "High", "Low", "Close", "Volume"]

        assert df is not None, "DataFrame should not be None"
        assert not df.empty, "DataFrame should not be empty"

        for col in expected_columns:
            assert col in df.columns, f"Column {col} should be present"

        # Check for NaN values in critical columns
        for col in ["Open", "Close"]:
            assert (
                not df[col].isna().any()
            ), f"Column {col} should not contain NaN values"

        # Check data types
        for col in ["Open", "High", "Low", "Close"]:
            assert pd.api.types.is_numeric_dtype(
                df[col]
            ), f"Column {col} should be numeric"

        assert pd.api.types.is_integer_dtype(df["Volume"]), "Volume should be integer"

    @staticmethod
    def assert_records_quality(records: List[Dict], expected_count: int = None):
        """Assert records meet quality standards."""
        assert records is not None, "Records should not be None"
        assert len(records) > 0, "Records should not be empty"

        if expected_count is not None:
            assert (
                len(records) == expected_count
            ), f"Expected {expected_count} records, got {len(records)}"

        # Check record structure
        required_fields = [
            "stock_code",
            "date",
            "open",
            "high",
            "low",
            "close",
            "adjusted_close",
            "volume",
        ]
        for record in records:
            for field in required_fields:
                assert field in record, f"Field {field} should be present in record"

            # Check data types and ranges
            assert isinstance(record["open"], float), "Open should be float"
            assert isinstance(record["close"], float), "Close should be float"
            assert isinstance(record["volume"], int), "Volume should be int"
            assert record["open"] > 0, "Open should be positive"
            assert record["close"] > 0, "Close should be positive"
            assert record["volume"] >= 0, "Volume should be non-negative"

    @staticmethod
    async def run_concurrent_tests(tasks: List, timeout: float = 30.0):
        """Run concurrent tests with timeout."""
        try:
            results = await asyncio.wait_for(
                asyncio.gather(*tasks, return_exceptions=True), timeout=timeout
            )
            return results
        except asyncio.TimeoutError:
            raise AssertionError(f"Tests timed out after {timeout} seconds")


# Test data constants
TEST_STOCK_DATA = {
    "CBA": TestDataGenerator.generate_stock_data("CBA", days=30, start_price=100.0),
    "BHP": TestDataGenerator.generate_stock_data("BHP", days=30, start_price=45.0),
    "CSL": TestDataGenerator.generate_stock_data("CSL", days=30, start_price=300.0),
}

TEST_CORRUPTED_DATA = {
    "TEST": TestDataGenerator.generate_corrupted_data("TEST", days=10),
}

TEST_EMPTY_DATA = TestDataGenerator.generate_empty_data()


if __name__ == "__main__":
    # Run basic tests
    print("🧪 Running test configuration validation...")

    # Test data generation
    test_df = TestDataGenerator.generate_stock_data("CBA", days=5)
    print(f"✅ Generated test data: {len(test_df)} records")

    # Test utilities
    TestUtilities.assert_dataframe_quality(test_df)
    print("✅ Data quality validation passed")

    # Test mock database
    mock_db = MockDatabase()
    print("✅ Mock database created")

    print("🎉 All test configuration validations passed!")
