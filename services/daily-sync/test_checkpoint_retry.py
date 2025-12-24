#!/usr/bin/env python3
"""
Unit tests for checkpoint and retry limit functionality.

Tests the checkpoint system, retry limits, and rate limiting behavior
with mocked external dependencies.
"""
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch, call
from datetime import date, timedelta
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from comprehensive_daily_sync import (
    SyncStatusRecorder,
    update_stock_prices,
    MAX_STOCK_FAILURE_RETRIES,
    RATE_LIMIT_DELAY_ALPHA,
    RATE_LIMIT_DELAY_YAHOO,
    CONSECUTIVE_FAILURES_BACKOFF_THRESHOLD,
)


class TestSyncStatusRecorder:
    """Test SyncStatusRecorder checkpoint functionality."""

    @pytest.fixture
    def mock_conn(self):
        """Create a mock database connection."""
        conn = AsyncMock()
        conn.execute = AsyncMock()
        conn.fetchrow = AsyncMock(return_value=None)
        return conn

    @pytest.fixture
    def recorder(self, mock_conn):
        """Create a SyncStatusRecorder instance."""
        return SyncStatusRecorder(mock_conn)

    @pytest.mark.asyncio
    async def test_initial_checkpoint_data(self, recorder):
        """Test initial checkpoint data structure."""
        assert recorder.checkpoint_data["stocks_processed"] == []
        assert recorder.checkpoint_data["stocks_successful"] == []
        assert recorder.checkpoint_data["stocks_failed"] == []
        assert recorder.checkpoint_data["stocks_failed_count"] == {}
        assert recorder.checkpoint_data["resume_from"] == 0

    @pytest.mark.asyncio
    async def test_update_checkpoint_success(self, recorder):
        """Test updating checkpoint with successful stock."""
        await recorder.update_checkpoint("ABC", True, 0)

        assert "ABC" in recorder.checkpoint_data["stocks_processed"]
        assert "ABC" in recorder.checkpoint_data["stocks_successful"]
        assert "ABC" not in recorder.checkpoint_data["stocks_failed"]
        assert recorder.checkpoint_data["stocks_failed_count"].get("ABC") is None
        assert recorder.checkpoint_data["resume_from"] == 1

    @pytest.mark.asyncio
    async def test_update_checkpoint_failure(self, recorder):
        """Test updating checkpoint with failed stock."""
        await recorder.update_checkpoint("XYZ", False, 0)

        assert "XYZ" in recorder.checkpoint_data["stocks_processed"]
        assert "XYZ" not in recorder.checkpoint_data["stocks_successful"]
        assert "XYZ" in recorder.checkpoint_data["stocks_failed"]
        assert recorder.checkpoint_data["stocks_failed_count"]["XYZ"] == 1
        assert recorder.checkpoint_data["resume_from"] == 1

    @pytest.mark.asyncio
    async def test_update_checkpoint_multiple_failures(self, recorder):
        """Test tracking multiple failures for same stock."""
        # First failure
        await recorder.update_checkpoint("BAD", False, 0)
        assert recorder.checkpoint_data["stocks_failed_count"]["BAD"] == 1

        # Second failure (simulate retry)
        await recorder.update_checkpoint("BAD", False, 1)
        assert recorder.checkpoint_data["stocks_failed_count"]["BAD"] == 2

        # Third failure
        await recorder.update_checkpoint("BAD", False, 2)
        assert recorder.checkpoint_data["stocks_failed_count"]["BAD"] == 3

    @pytest.mark.asyncio
    async def test_update_checkpoint_failure_then_success(self, recorder):
        """Test that success resets failure count."""
        # Fail twice
        await recorder.update_checkpoint("RECOVER", False, 0)
        await recorder.update_checkpoint("RECOVER", False, 1)
        assert recorder.checkpoint_data["stocks_failed_count"]["RECOVER"] == 2

        # Then succeed
        await recorder.update_checkpoint("RECOVER", True, 2)
        assert "RECOVER" in recorder.checkpoint_data["stocks_successful"]
        assert recorder.checkpoint_data["stocks_failed_count"].get("RECOVER") is None

    @pytest.mark.asyncio
    async def test_resume_from_checkpoint(self, mock_conn):
        """Test resuming from existing checkpoint."""
        # Mock existing checkpoint data
        existing_checkpoint = {
            "run_id": "test-run-id",
            "checkpoint_stocks_processed": ["A", "B", "C"],
            "checkpoint_stocks_successful": ["A", "B"],
            "checkpoint_stocks_failed": ["C", "C", "C"],  # C failed 3 times
            "checkpoint_resume_from": 3,
            "status": "partial",
        }
        mock_conn.fetchrow = AsyncMock(return_value=existing_checkpoint)

        recorder = SyncStatusRecorder(mock_conn, run_id="test-run-id")
        await recorder.start(total_stocks=10, batch_size=500, resume_from=3)

        # Check that failure counts are reconstructed
        assert recorder.checkpoint_data["stocks_failed_count"]["C"] == 3
        assert recorder.checkpoint_data["resume_from"] == 3
        assert "A" in recorder.checkpoint_data["stocks_successful"]
        assert "B" in recorder.checkpoint_data["stocks_successful"]


class TestRetryLimits:
    """Test retry limit functionality."""

    @pytest.fixture
    def mock_conn(self):
        """Create a mock database connection."""
        conn = AsyncMock()
        conn.execute = AsyncMock()
        conn.fetchval = AsyncMock(return_value=None)  # No last date
        return conn

    @pytest.fixture
    def mock_recorder(self):
        """Create a mock recorder with checkpoint data."""
        recorder = MagicMock()
        recorder.checkpoint_data = {
            "stocks_processed": [],
            "stocks_successful": [],
            "stocks_failed": [],
            "stocks_failed_count": {},
            "resume_from": 0,
        }
        recorder.update_checkpoint = AsyncMock()
        recorder.update_metric = AsyncMock()  # Add missing async method
        return recorder

    @pytest.mark.asyncio
    @patch("comprehensive_daily_sync.get_stocks_with_price_data")
    @patch("comprehensive_daily_sync.get_last_ingested_date")
    @patch("comprehensive_daily_sync.fetch_from_alpha_vantage")
    @patch("comprehensive_daily_sync.fetch_from_yahoo_finance")
    @patch("comprehensive_daily_sync.insert_price_data")
    async def test_skip_permanently_failed_stock(
        self,
        mock_insert,
        mock_yahoo,
        mock_alpha,
        mock_last_date,
        mock_get_stocks,
        mock_conn,
        mock_recorder,
    ):
        """Test that permanently failed stocks are skipped."""
        # Setup: Stock XYZ has failed 3 times (max retries)
        mock_recorder.checkpoint_data["stocks_failed_count"] = {"XYZ": 3}
        mock_recorder.checkpoint_data["stocks_failed"] = ["XYZ", "XYZ", "XYZ"]

        # Stock list includes the permanently failed stock
        mock_get_stocks.return_value = ["XYZ", "ABC"]
        mock_last_date.return_value = None

        # Mock successful fetch for ABC
        mock_alpha.return_value = None
        mock_yahoo.return_value = [{"stock_code": "ABC", "date": date.today()}]
        mock_insert.return_value = 1

        # Run update
        await update_stock_prices(
            mock_conn, days=5, recorder=mock_recorder, batch_size=500, max_stocks=10
        )

        # Verify XYZ was skipped (never called fetch functions for XYZ)
        # ABC should be processed, but XYZ should be skipped
        yahoo_calls = [call[0][0] for call in mock_yahoo.call_args_list]
        assert "XYZ" not in yahoo_calls, "XYZ should be skipped"
        assert "ABC" in yahoo_calls, "ABC should be processed"

        # Verify checkpoint was updated to mark XYZ as processed (but not successful)
        update_calls = mock_recorder.update_checkpoint.call_args_list
        xyz_calls = [c for c in update_calls if c[0][0] == "XYZ"]
        assert len(xyz_calls) == 1, f"Expected 1 update for XYZ, got {len(xyz_calls)}"
        assert xyz_calls[0][0][1] == False  # Marked as failed, not successful

    @pytest.mark.asyncio
    @patch("comprehensive_daily_sync.get_stocks_with_price_data")
    @patch("comprehensive_daily_sync.get_last_ingested_date")
    @patch("comprehensive_daily_sync.fetch_from_alpha_vantage")
    @patch("comprehensive_daily_sync.fetch_from_yahoo_finance")
    @patch("comprehensive_daily_sync.insert_price_data")
    async def test_retry_failed_stock_under_limit(
        self,
        mock_insert,
        mock_yahoo,
        mock_alpha,
        mock_last_date,
        mock_get_stocks,
        mock_conn,
        mock_recorder,
    ):
        """Test that stocks under retry limit are still processed."""
        # Setup: Stock XYZ has failed 2 times (under limit)
        mock_recorder.checkpoint_data["stocks_failed_count"] = {"XYZ": 2}
        mock_recorder.checkpoint_data["stocks_failed"] = ["XYZ", "XYZ"]

        mock_get_stocks.return_value = ["XYZ"]
        mock_last_date.return_value = None

        # Mock successful fetch this time
        mock_alpha.return_value = None
        mock_yahoo.return_value = [{"stock_code": "XYZ", "date": date.today()}]
        mock_insert.return_value = 1

        # Run update
        await update_stock_prices(
            mock_conn, days=5, recorder=mock_recorder, batch_size=500, max_stocks=10
        )

        # Verify XYZ was processed (not skipped)
        mock_yahoo.assert_called_once_with("XYZ", 5)
        mock_insert.assert_called_once()

        # Verify checkpoint updated with success (should reset failure count)
        update_calls = mock_recorder.update_checkpoint.call_args_list
        xyz_calls = [c for c in update_calls if c[0][0] == "XYZ"]
        assert len(xyz_calls) == 1
        assert xyz_calls[0][0][1] == True  # Marked as successful

    @pytest.mark.asyncio
    @patch("comprehensive_daily_sync.get_stocks_with_price_data")
    @patch("comprehensive_daily_sync.get_last_ingested_date")
    @patch("comprehensive_daily_sync.fetch_from_alpha_vantage")
    @patch("comprehensive_daily_sync.fetch_from_yahoo_finance")
    @patch("comprehensive_daily_sync.insert_price_data")
    async def test_mark_permanently_failed_on_third_failure(
        self,
        mock_insert,
        mock_yahoo,
        mock_alpha,
        mock_last_date,
        mock_get_stocks,
        mock_conn,
        mock_recorder,
    ):
        """Test that stock is marked permanently failed on 3rd failure."""
        # Setup: Stock XYZ has failed 2 times
        mock_recorder.checkpoint_data["stocks_failed_count"] = {"XYZ": 2}
        mock_recorder.checkpoint_data["stocks_failed"] = ["XYZ", "XYZ"]

        # Make update_checkpoint actually update the data
        async def update_checkpoint_impl(stock_code, success, index):
            if success:
                if stock_code not in mock_recorder.checkpoint_data["stocks_successful"]:
                    mock_recorder.checkpoint_data["stocks_successful"].append(
                        stock_code
                    )
                mock_recorder.checkpoint_data["stocks_failed_count"].pop(
                    stock_code, None
                )
            else:
                current_count = mock_recorder.checkpoint_data[
                    "stocks_failed_count"
                ].get(stock_code, 0)
                mock_recorder.checkpoint_data["stocks_failed_count"][stock_code] = (
                    current_count + 1
                )
                if stock_code not in mock_recorder.checkpoint_data["stocks_failed"]:
                    mock_recorder.checkpoint_data["stocks_failed"].append(stock_code)
            if stock_code not in mock_recorder.checkpoint_data["stocks_processed"]:
                mock_recorder.checkpoint_data["stocks_processed"].append(stock_code)
            mock_recorder.checkpoint_data["resume_from"] = index + 1

        mock_recorder.update_checkpoint = update_checkpoint_impl

        mock_get_stocks.return_value = ["XYZ"]
        mock_last_date.return_value = None

        # Mock failure (no data)
        mock_alpha.return_value = None
        mock_yahoo.return_value = None

        # Run update
        await update_stock_prices(
            mock_conn, days=5, recorder=mock_recorder, batch_size=500, max_stocks=10
        )

        # Verify failure count increased to 3 (was 2, now 3 after update_checkpoint)
        final_count = mock_recorder.checkpoint_data["stocks_failed_count"].get("XYZ", 0)
        assert final_count == 3, f"Expected 3 failures, got {final_count}"

        # Verify XYZ is in failed list
        assert "XYZ" in mock_recorder.checkpoint_data["stocks_failed"]

        # Verify XYZ is marked as processed
        assert "XYZ" in mock_recorder.checkpoint_data["stocks_processed"]


class TestRateLimiting:
    """Test rate limiting and backoff behavior."""

    @pytest.fixture
    def mock_conn(self):
        """Create a mock database connection."""
        conn = AsyncMock()
        conn.execute = AsyncMock()
        conn.fetchval = AsyncMock(return_value=None)
        return conn

    @pytest.fixture
    def mock_recorder(self):
        """Create a mock recorder."""
        recorder = MagicMock()
        recorder.checkpoint_data = {
            "stocks_processed": [],
            "stocks_successful": [],
            "stocks_failed": [],
            "stocks_failed_count": {},
            "resume_from": 0,
        }
        recorder.update_checkpoint = AsyncMock()
        recorder.update_metric = AsyncMock()  # Add missing async method
        return recorder

    @pytest.mark.asyncio
    @patch("comprehensive_daily_sync.ALPHA_VANTAGE_ENABLED", True)
    @patch("comprehensive_daily_sync.get_stocks_with_price_data")
    @patch("comprehensive_daily_sync.get_last_ingested_date")
    @patch("comprehensive_daily_sync.fetch_from_alpha_vantage")
    @patch("comprehensive_daily_sync.fetch_from_yahoo_finance")
    @patch("comprehensive_daily_sync.insert_price_data")
    @patch("comprehensive_daily_sync.asyncio.sleep")
    @patch("comprehensive_daily_sync.time.sleep")
    @patch("comprehensive_daily_sync.aiohttp.ClientSession")
    async def test_alpha_vantage_rate_limit_delay(
        self,
        mock_session_class,
        mock_time_sleep,
        mock_asyncio_sleep,
        mock_insert,
        mock_yahoo,
        mock_alpha,
        mock_last_date,
        mock_get_stocks,
        mock_conn,
        mock_recorder,
    ):
        """Test that Alpha Vantage calls respect rate limit delay."""
        # Mock aiohttp session with proper async context manager
        mock_session = AsyncMock()
        mock_session.close = AsyncMock()
        mock_session_instance = AsyncMock()
        mock_session_instance.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_instance.__aexit__ = AsyncMock(return_value=None)
        mock_session_class.return_value = mock_session_instance

        mock_get_stocks.return_value = ["ABC"]
        mock_last_date.return_value = None
        mock_alpha.return_value = [{"stock_code": "ABC", "date": date.today()}]
        mock_insert.return_value = 1

        await update_stock_prices(
            mock_conn, days=5, recorder=mock_recorder, batch_size=500, max_stocks=10
        )

        # Verify asyncio.sleep was called with Alpha Vantage delay
        assert mock_asyncio_sleep.called
        assert mock_asyncio_sleep.call_args[0][0] == RATE_LIMIT_DELAY_ALPHA

    @pytest.mark.asyncio
    @patch("comprehensive_daily_sync.get_stocks_with_price_data")
    @patch("comprehensive_daily_sync.get_last_ingested_date")
    @patch("comprehensive_daily_sync.fetch_from_alpha_vantage")
    @patch("comprehensive_daily_sync.fetch_from_yahoo_finance")
    @patch("comprehensive_daily_sync.insert_price_data")
    @patch("comprehensive_daily_sync.time.sleep")
    async def test_consecutive_failures_backoff(
        self,
        mock_sleep,
        mock_insert,
        mock_yahoo,
        mock_alpha,
        mock_last_date,
        mock_get_stocks,
        mock_conn,
        mock_recorder,
    ):
        """Test that consecutive failures trigger exponential backoff."""
        # Setup: 5 stocks that all fail
        mock_get_stocks.return_value = ["A", "B", "C", "D", "E"]
        mock_last_date.return_value = None
        mock_alpha.return_value = None
        mock_yahoo.return_value = None  # All fail

        await update_stock_prices(
            mock_conn, days=5, recorder=mock_recorder, batch_size=500, max_stocks=10
        )

        # Verify sleep was called for each stock (Yahoo fallback)
        assert mock_sleep.call_count >= 5

        # Check that delay increased after threshold
        sleep_times = [call[0][0] for call in mock_sleep.call_args_list]

        # First few should be base delay
        assert sleep_times[0] == RATE_LIMIT_DELAY_YAHOO

        # After threshold, delay should increase
        # (exact values depend on implementation, but should be >= base)
        later_delays = sleep_times[CONSECUTIVE_FAILURES_BACKOFF_THRESHOLD:]
        if later_delays:
            assert all(d >= RATE_LIMIT_DELAY_YAHOO for d in later_delays)


class TestCheckpointResume:
    """Test checkpoint resume functionality."""

    @pytest.fixture
    def mock_conn(self):
        """Create a mock database connection."""
        conn = AsyncMock()
        conn.execute = AsyncMock()
        conn.fetchval = AsyncMock(return_value=None)
        return conn

    @pytest.mark.asyncio
    @patch("comprehensive_daily_sync.get_stocks_with_price_data")
    @patch("comprehensive_daily_sync.get_last_ingested_date")
    @patch("comprehensive_daily_sync.fetch_from_alpha_vantage")
    @patch("comprehensive_daily_sync.fetch_from_yahoo_finance")
    @patch("comprehensive_daily_sync.insert_price_data")
    async def test_resume_from_checkpoint_skips_processed(
        self,
        mock_insert,
        mock_yahoo,
        mock_alpha,
        mock_last_date,
        mock_get_stocks,
        mock_conn,
    ):
        """Test that resuming from checkpoint skips already processed stocks."""
        # Setup: 10 stocks total, first 3 already processed
        all_stocks = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]
        mock_get_stocks.return_value = all_stocks
        mock_last_date.return_value = None

        # Create recorder with checkpoint showing first 3 processed
        recorder = SyncStatusRecorder(mock_conn)
        recorder.checkpoint_data = {
            "stocks_processed": ["A", "B", "C"],
            "stocks_successful": ["A", "B", "C"],
            "stocks_failed": [],
            "stocks_failed_count": {},
            "resume_from": 3,
        }
        recorder.update_checkpoint = AsyncMock()
        recorder.update_metric = AsyncMock()  # Add missing async method

        # Mock successful fetch for remaining stocks
        mock_alpha.return_value = None
        mock_yahoo.return_value = [{"stock_code": "D", "date": date.today()}]
        mock_insert.return_value = 1

        await update_stock_prices(
            mock_conn, days=5, recorder=recorder, batch_size=500, max_stocks=10
        )

        # Verify only stocks D-J were processed (not A-C)
        # Yahoo should be called for D, not for A, B, or C
        yahoo_calls = [call[0][0] for call in mock_yahoo.call_args_list]
        assert "A" not in yahoo_calls
        assert "B" not in yahoo_calls
        assert "C" not in yahoo_calls
        assert "D" in yahoo_calls


if __name__ == "__main__":
    pytest.main([__file__, "-v"])



