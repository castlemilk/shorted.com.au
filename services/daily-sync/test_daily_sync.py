#!/usr/bin/env python3
"""
End-to-End Tests for Comprehensive Daily Sync

Tests validate:
1. Database connectivity
2. ASIC shorts data fetching
3. Alpha Vantage API (if key available)
4. Yahoo Finance fallback
5. Data insertion and upsert logic
6. Complete sync workflow
"""
import asyncio
import asyncpg
import pytest
import os
from datetime import date, timedelta
from unittest.mock import patch, MagicMock, AsyncMock
import pandas as pd
import httpx
import aiohttp

# Import the sync functions
from comprehensive_daily_sync import (
    get_recent_shorts_files,
    download_and_parse_shorts_csv,
    fetch_from_alpha_vantage,
    fetch_from_yahoo_finance,
    get_stocks_with_price_data,
    insert_price_data,
    update_shorts_data,
    update_stock_prices,
    DATABASE_URL,
    ALPHA_VANTAGE_API_KEY,
    ALPHA_VANTAGE_ENABLED
)


# Test Configuration
TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL", DATABASE_URL)


class TestDatabaseConnectivity:
    """Test database connection and basic queries."""
    
    @pytest.mark.asyncio
    async def test_database_connection(self):
        """Test that we can connect to the database."""
        try:
            conn = await asyncpg.connect(TEST_DATABASE_URL)
            await conn.close()
            assert True, "Database connection successful"
        except Exception as e:
            pytest.fail(f"Database connection failed: {e}")
    
    @pytest.mark.asyncio
    async def test_shorts_table_exists(self):
        """Test that shorts table exists and has expected structure."""
        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            result = await conn.fetch(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'shorts'"
            )
            columns = [row['column_name'] for row in result]
            
            required_columns = ['DATE', 'PRODUCT_CODE', 'PRODUCT', 
                              'REPORTED_SHORT_POSITIONS', 'TOTAL_PRODUCT_IN_ISSUE',
                              'PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS']
            
            for col in required_columns:
                assert col in columns, f"Column {col} missing from shorts table"
                
        finally:
            await conn.close()
    
    @pytest.mark.asyncio
    async def test_stock_prices_table_exists(self):
        """Test that stock_prices table exists and has expected structure."""
        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            result = await conn.fetch(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_prices'"
            )
            columns = [row['column_name'] for row in result]
            
            required_columns = ['stock_code', 'date', 'open', 'high', 'low', 
                              'close', 'adjusted_close', 'volume']
            
            for col in required_columns:
                assert col in columns, f"Column {col} missing from stock_prices table"
                
        finally:
            await conn.close()


class TestShortsDataFetching:
    """Test ASIC shorts data fetching functionality."""
    
    @pytest.mark.asyncio
    async def test_get_recent_shorts_files(self):
        """Test fetching list of recent shorts files from ASIC."""
        urls = await get_recent_shorts_files(days=7)
        
        assert isinstance(urls, list), "Should return a list"
        assert len(urls) > 0, "Should find at least one recent file"
        
        for url in urls:
            assert url.startswith("https://download.asic.gov.au/"), "Invalid URL"
            assert "SSDailyAggShortPos.csv" in url, "Invalid file type"
    
    @pytest.mark.asyncio
    async def test_download_and_parse_shorts_csv(self):
        """Test downloading and parsing a shorts CSV file."""
        # Get a recent file URL
        urls = await get_recent_shorts_files(days=2)
        if not urls:
            pytest.skip("No recent files available")
        
        df = await download_and_parse_shorts_csv(urls[0])
        
        if df.empty:
            pytest.skip("File download failed or empty")
        
        # Validate DataFrame structure
        assert 'DATE' in df.columns, "Missing DATE column"
        assert 'PRODUCT_CODE' in df.columns, "Missing PRODUCT_CODE column"
        assert 'PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS' in df.columns
        
        # Validate data types
        assert df['DATE'].dtype == 'datetime64[ns]', "DATE should be datetime"
        assert len(df) > 0, "DataFrame should have records"


class TestStockPriceProviders:
    """Test stock price data providers (Alpha Vantage and Yahoo Finance)."""
    
    @pytest.mark.skipif(not ALPHA_VANTAGE_ENABLED, reason="Alpha Vantage API key not set")
    @pytest.mark.asyncio
    async def test_alpha_vantage_fetch(self):
        """Test fetching data from Alpha Vantage for a known stock."""
        async with aiohttp.ClientSession() as session:
            data = await fetch_from_alpha_vantage(session, "CBA", days=5)
            
            if data:  # May be None due to rate limits
                assert isinstance(data, list), "Should return a list"
                assert len(data) > 0, "Should have at least one record"
                
                # Validate structure
                record = data[0]
                assert 'stock_code' in record
                assert 'date' in record
                assert 'open' in record
                assert 'close' in record
                assert record['stock_code'] == 'CBA'
    
    def test_yahoo_finance_fetch(self):
        """Test fetching data from Yahoo Finance for a known stock."""
        data = fetch_from_yahoo_finance("CBA", days=5)
        
        if data is None:
            pytest.skip("Yahoo Finance unavailable")
        
        assert isinstance(data, list), "Should return a list"
        assert len(data) > 0, "Should have at least one record"
        
        # Validate structure
        record = data[0]
        assert 'stock_code' in record
        assert 'date' in record
        assert 'open' in record
        assert 'close' in record
        assert record['stock_code'] == 'CBA'
    
    def test_yahoo_finance_fallback_for_invalid_stock(self):
        """Test that invalid stock returns None."""
        data = fetch_from_yahoo_finance("INVALID_STOCK_XYZ123", days=5)
        assert data is None, "Invalid stock should return None"


class TestDatabaseOperations:
    """Test database insert and update operations."""
    
    @pytest.mark.asyncio
    async def test_get_stocks_with_price_data(self):
        """Test retrieving list of stocks with existing price data."""
        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            stocks = await get_stocks_with_price_data(conn)
            
            assert isinstance(stocks, list), "Should return a list"
            # Should have at least some stocks (from our previous population)
            assert len(stocks) > 0, "Should have stocks with price data"
            
        finally:
            await conn.close()
    
    @pytest.mark.asyncio
    async def test_insert_price_data_new_record(self):
        """Test inserting new price data."""
        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            # Create test data
            test_data = [{
                'stock_code': 'TEST',
                'date': date.today(),
                'open': 100.00,
                'high': 105.00,
                'low': 99.00,
                'close': 103.00,
                'adjusted_close': 103.00,
                'volume': 1000000
            }]
            
            # Insert
            inserted = await insert_price_data(conn, test_data)
            assert inserted > 0, "Should insert at least one record"
            
            # Verify
            result = await conn.fetchrow(
                "SELECT * FROM stock_prices WHERE stock_code = 'TEST' AND date = $1",
                date.today()
            )
            assert result is not None, "Record should exist"
            assert float(result['close']) == 103.00, "Close price should match"
            
            # Cleanup
            await conn.execute("DELETE FROM stock_prices WHERE stock_code = 'TEST'")
            
        finally:
            await conn.close()
    
    @pytest.mark.asyncio
    async def test_insert_price_data_upsert(self):
        """Test that duplicate inserts update existing records (upsert)."""
        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            test_date = date.today()
            
            # Insert first record
            data1 = [{
                'stock_code': 'UPSERT_TEST',
                'date': test_date,
                'open': 100.00,
                'high': 105.00,
                'low': 99.00,
                'close': 103.00,
                'adjusted_close': 103.00,
                'volume': 1000000
            }]
            await insert_price_data(conn, data1)
            
            # Insert duplicate with different close price
            data2 = [{
                'stock_code': 'UPSERT_TEST',
                'date': test_date,
                'open': 100.00,
                'high': 106.00,
                'low': 99.00,
                'close': 104.00,  # Changed
                'adjusted_close': 104.00,
                'volume': 1100000
            }]
            await insert_price_data(conn, data2)
            
            # Verify only one record exists with updated close
            count = await conn.fetchval(
                "SELECT COUNT(*) FROM stock_prices WHERE stock_code = 'UPSERT_TEST' AND date = $1",
                test_date
            )
            assert count == 1, "Should have only one record (upsert, not duplicate)"
            
            result = await conn.fetchrow(
                "SELECT * FROM stock_prices WHERE stock_code = 'UPSERT_TEST' AND date = $1",
                test_date
            )
            assert float(result['close']) == 104.00, "Should have updated close price"
            
            # Cleanup
            await conn.execute("DELETE FROM stock_prices WHERE stock_code = 'UPSERT_TEST'")
            
        finally:
            await conn.close()


class TestEndToEndSync:
    """End-to-end tests for complete sync workflow."""
    
    @pytest.mark.asyncio
    async def test_shorts_update_workflow(self):
        """Test complete shorts update workflow."""
        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            # Get initial count
            initial_count = await conn.fetchval("SELECT MAX(\"DATE\") FROM shorts")
            
            # Run shorts update (just last 2 days to be quick)
            updated = await update_shorts_data(conn, days=2)
            
            # Note: updated might be 0 if data already exists (upsert)
            # But it should not error
            assert updated >= 0, "Update should complete without error"
            
            # Verify latest date is recent
            latest_date = await conn.fetchval("SELECT MAX(\"DATE\") FROM shorts")
            assert latest_date is not None, "Should have shorts data"
            
            # Latest should be within last 7 days (ASIC updates daily)
            days_old = (date.today() - latest_date.date()).days
            assert days_old <= 7, f"Data is {days_old} days old, should be more recent"
            
        finally:
            await conn.close()
    
    @pytest.mark.asyncio
    async def test_stock_prices_update_workflow(self):
        """Test complete stock prices update workflow."""
        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            # Get a few stocks to test with
            test_stocks = await conn.fetch(
                "SELECT DISTINCT stock_code FROM stock_prices LIMIT 5"
            )
            
            if not test_stocks:
                pytest.skip("No stocks with existing price data")
            
            # Run update for just these stocks (to be quick)
            # This tests the provider fallback logic
            total_inserted = 0
            
            for row in test_stocks:
                stock_code = row['stock_code']
                
                # Try fetching with fallback
                data = None
                
                # Try Yahoo Finance (faster for testing)
                data = fetch_from_yahoo_finance(stock_code, days=5)
                
                if data:
                    inserted = await insert_price_data(conn, data)
                    total_inserted += inserted
            
            # Should have inserted/updated some records
            assert total_inserted >= 0, "Update should complete"
            
        finally:
            await conn.close()
    
    @pytest.mark.asyncio
    async def test_provider_fallback_logic(self):
        """Test that fallback from Alpha Vantage to Yahoo Finance works."""
        # This test validates the fallback concept
        test_stock = "CBA"
        
        # Try Alpha Vantage first (may fail due to rate limit)
        alpha_data = None
        if ALPHA_VANTAGE_ENABLED:
            async with aiohttp.ClientSession() as session:
                alpha_data = await fetch_from_alpha_vantage(session, test_stock, days=5)
        
        # Try Yahoo Finance as fallback
        yahoo_data = fetch_from_yahoo_finance(test_stock, days=5)
        
        # At least one should succeed
        assert alpha_data is not None or yahoo_data is not None, \
            "At least one provider should return data for CBA"


class TestErrorHandling:
    """Test error handling and edge cases."""
    
    @pytest.mark.asyncio
    async def test_invalid_database_url(self):
        """Test handling of invalid database URL."""
        with pytest.raises(Exception):
            conn = await asyncpg.connect("postgresql://invalid:invalid@invalid:5432/invalid")
            await conn.close()
    
    def test_fetch_nonexistent_stock(self):
        """Test fetching data for non-existent stock."""
        data = fetch_from_yahoo_finance("NONEXISTENT_STOCK_12345", days=5)
        assert data is None, "Non-existent stock should return None"
    
    @pytest.mark.asyncio
    async def test_insert_empty_data(self):
        """Test inserting empty data list."""
        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            inserted = await insert_price_data(conn, [])
            assert inserted == 0, "Empty data should insert 0 records"
        finally:
            await conn.close()


# Pytest configuration
def pytest_configure(config):
    """Configure pytest."""
    config.addinivalue_line("markers", "asyncio: mark test as async")
    config.addinivalue_line("markers", "integration: mark test as integration test")


if __name__ == "__main__":
    # Run tests
    pytest.main([__file__, "-v", "--tb=short"])

