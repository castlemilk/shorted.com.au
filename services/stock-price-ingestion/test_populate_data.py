#!/usr/bin/env python3
"""
Test script for data population functionality
"""
import asyncio
import pytest
from datetime import date, timedelta
from unittest.mock import AsyncMock, patch, MagicMock
import pandas as pd
from populate_historical_data import HistoricalDataIngestion, IngestionStats


@pytest.fixture
async def ingestion():
    """Create a test ingestion instance"""
    ingestion = HistoricalDataIngestion("postgresql://test", max_workers=2)
    ingestion.pool = AsyncMock()
    return ingestion


@pytest.fixture
def sample_stock_data():
    """Create sample stock data for testing"""
    dates = pd.date_range(start='2024-01-01', end='2024-01-05', freq='B')
    return pd.DataFrame({
        'date': dates,
        'stock_code': ['CBA'] * len(dates),
        'open': [100.0, 101.0, 99.5],
        'high': [101.0, 102.5, 101.0],
        'low': [99.0, 100.0, 99.0],
        'close': [100.5, 101.5, 100.0],
        'adjusted_close': [100.5, 101.5, 100.0],
        'volume': [1000000, 1200000, 900000]
    })


class TestHistoricalDataIngestion:
    
    def test_get_asx_stocks(self):
        """Test getting ASX stock list"""
        ingestion = HistoricalDataIngestion("postgresql://test")
        stocks = ingestion.get_asx_stocks()
        
        assert isinstance(stocks, list)
        assert len(stocks) > 50  # Should have plenty of stocks
        assert 'CBA' in stocks
        assert 'BHP' in stocks
        assert all(isinstance(stock, str) for stock in stocks)
        assert stocks == sorted(stocks)  # Should be sorted
    
    @pytest.mark.asyncio
    async def test_setup_database(self, ingestion):
        """Test database setup"""
        # Mock table exists check
        ingestion.pool.acquire.return_value.__aenter__.return_value.fetchval.return_value = True
        
        await ingestion.setup_database()
        
        # Should check if table exists
        ingestion.pool.acquire.return_value.__aenter__.return_value.fetchval.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_fetch_stock_data_success(self, ingestion, sample_stock_data):
        """Test successful stock data fetching"""
        with patch('yfinance.Ticker') as mock_ticker:
            # Mock yfinance response
            mock_ticker.return_value.history.return_value = sample_stock_data.drop('stock_code', axis=1)
            
            result = await ingestion.fetch_stock_data('CBA', date(2024, 1, 1), date(2024, 1, 5))
            
            assert result is not None
            assert 'stock_code' in result.columns
            assert result['stock_code'].iloc[0] == 'CBA'
            assert 'date' in result.columns
            assert 'close' in result.columns
    
    @pytest.mark.asyncio
    async def test_fetch_stock_data_validation_failure(self, ingestion):
        """Test stock data fetch with validation failure"""
        with patch('yfinance.Ticker') as mock_ticker:
            # Create invalid data (negative prices)
            bad_data = pd.DataFrame({
                'Date': pd.date_range(start='2024-01-01', periods=3),
                'Open': [100.0, -50.0, 102.0],  # Negative price
                'High': [101.0, 102.0, 103.0],
                'Low': [99.0, -55.0, 101.0],
                'Close': [100.5, -51.0, 102.5],
                'Adj Close': [100.5, -51.0, 102.5],
                'Volume': [1000000, 1200000, 1100000]
            })
            mock_ticker.return_value.history.return_value = bad_data
            
            result = await ingestion.fetch_stock_data('TEST', date(2024, 1, 1), date(2024, 1, 5))
            
            assert result is None
            assert ingestion.stats.validation_errors == 1
    
    @pytest.mark.asyncio
    async def test_fetch_stock_data_empty_response(self, ingestion):
        """Test handling of empty data response"""
        with patch('yfinance.Ticker') as mock_ticker:
            mock_ticker.return_value.history.return_value = pd.DataFrame()
            
            result = await ingestion.fetch_stock_data('INVALID', date(2024, 1, 1), date(2024, 1, 5))
            
            assert result is None
    
    @pytest.mark.asyncio
    async def test_insert_stock_data(self, ingestion, sample_stock_data):
        """Test stock data insertion"""
        # Mock the copy_records_to_table method
        ingestion.pool.acquire.return_value.__aenter__.return_value.copy_records_to_table.return_value = "COPY 3"
        
        records_inserted = await ingestion.insert_stock_data(sample_stock_data)
        
        assert records_inserted == 3
        ingestion.pool.acquire.return_value.__aenter__.return_value.copy_records_to_table.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_insert_empty_dataframe(self, ingestion):
        """Test insertion of empty dataframe"""
        result = await ingestion.insert_stock_data(pd.DataFrame())
        assert result == 0
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_integration(self, ingestion):
        """Test circuit breaker integration"""
        # Mock failures to trigger circuit breaker
        with patch('yfinance.Ticker') as mock_ticker:
            mock_ticker.side_effect = Exception("API Error")
            
            # Try multiple times to trigger circuit breaker
            for _ in range(6):  # More than failure threshold
                result = await ingestion.fetch_stock_data('TEST', date(2024, 1, 1), date(2024, 1, 5))
                assert result is None
            
            # Circuit breaker should be open now
            cb_metrics = ingestion.circuit_breaker.get_metrics()
            assert cb_metrics['state'] == 'open'
            assert cb_metrics['failure_count'] >= 5
    
    def test_stats_tracking(self):
        """Test statistics tracking"""
        stats = IngestionStats()
        
        assert stats.total_stocks == 0
        assert stats.successful_stocks == 0
        assert stats.failed_stocks == 0
        assert stats.total_records == 0
        assert stats.validation_errors == 0
        assert stats.start_time is None
        assert stats.end_time is None


@pytest.mark.asyncio
async def test_process_stock_success():
    """Test successful stock processing"""
    ingestion = HistoricalDataIngestion("postgresql://test")
    ingestion.pool = AsyncMock()
    
    # Mock successful data fetch and insert
    with patch.object(ingestion, 'fetch_stock_data') as mock_fetch, \
         patch.object(ingestion, 'insert_stock_data') as mock_insert:
        
        mock_fetch.return_value = pd.DataFrame({'close': [100.0, 101.0]})
        mock_insert.return_value = 2
        
        # Create a mock progress bar
        mock_pbar = MagicMock()
        
        result = await ingestion.process_stock('CBA', date(2024, 1, 1), date(2024, 1, 5), mock_pbar)
        
        assert result is True
        assert ingestion.stats.total_records == 2
        mock_pbar.update.assert_called_once_with(1)


@pytest.mark.asyncio
async def test_process_stock_failure():
    """Test stock processing failure"""
    ingestion = HistoricalDataIngestion("postgresql://test")
    ingestion.pool = AsyncMock()
    
    # Mock failed data fetch
    with patch.object(ingestion, 'fetch_stock_data') as mock_fetch:
        mock_fetch.return_value = None
        
        mock_pbar = MagicMock()
        result = await ingestion.process_stock('INVALID', date(2024, 1, 1), date(2024, 1, 5), mock_pbar)
        
        assert result is False
        assert 'INVALID' in ingestion.failed_stocks


if __name__ == "__main__":
    pytest.main([__file__, "-v"])