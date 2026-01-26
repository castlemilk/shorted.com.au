#!/usr/bin/env python3
"""
Test circuit breaker integration with stock price ingestion
"""
import asyncio
import pytest
from datetime import date, timedelta
from unittest.mock import MagicMock, AsyncMock, patch
import pandas as pd
from circuit_breaker import CircuitBreaker, CircuitBreakerConfig, CircuitState


class TestCircuitBreaker:
    """Test circuit breaker functionality"""
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_success(self):
        """Test circuit breaker with successful calls"""
        cb = CircuitBreaker()
        
        async def success_func():
            return "success"
        
        result = await cb.call(success_func)
        assert result == "success"
        assert cb.get_state() == CircuitState.CLOSED
        
    @pytest.mark.asyncio
    async def test_circuit_breaker_failure_threshold(self):
        """Test circuit breaker opens after failure threshold"""
        config = CircuitBreakerConfig(failure_threshold=3)
        cb = CircuitBreaker(config)
        
        async def failing_func():
            raise Exception("Test failure")
        
        # First 3 failures
        for i in range(3):
            with pytest.raises(Exception):
                await cb.call(failing_func)
        
        # Circuit should be open now
        assert cb.get_state() == CircuitState.OPEN
        
        # Next call should fail immediately
        with pytest.raises(Exception) as exc_info:
            await cb.call(failing_func)
        assert "Circuit breaker is OPEN" in str(exc_info.value)
        
    @pytest.mark.asyncio
    async def test_circuit_breaker_recovery(self):
        """Test circuit breaker recovery after timeout"""
        config = CircuitBreakerConfig(
            failure_threshold=2,
            recovery_timeout=0.1,  # 100ms for testing
            half_open_max_calls=2
        )
        cb = CircuitBreaker(config)
        
        async def failing_func():
            raise Exception("Test failure")
        
        async def success_func():
            return "success"
        
        # Open the circuit
        for i in range(2):
            with pytest.raises(Exception):
                await cb.call(failing_func)
        
        assert cb.get_state() == CircuitState.OPEN
        
        # Wait for recovery timeout
        await asyncio.sleep(0.2)
        
        # Circuit should go to half-open and allow test calls
        result = await cb.call(success_func)
        assert result == "success"
        assert cb.get_state() == CircuitState.HALF_OPEN
        
        # Another successful call should close the circuit
        result = await cb.call(success_func)
        assert cb.get_state() == CircuitState.CLOSED
        
    @pytest.mark.asyncio
    async def test_sync_function_support(self):
        """Test circuit breaker with synchronous functions"""
        cb = CircuitBreaker()
        
        def sync_func(x, y):
            return x + y
        
        result = await cb.call(sync_func, 1, 2)
        assert result == 3
        
    @pytest.mark.asyncio
    async def test_get_metrics(self):
        """Test circuit breaker metrics"""
        cb = CircuitBreaker()
        
        metrics = cb.get_metrics()
        assert metrics["state"] == "closed"
        assert metrics["failure_count"] == 0
        assert metrics["last_failure_time"] is None


@pytest.mark.asyncio
async def test_stock_ingestion_with_circuit_breaker():
    """Test stock price ingestion with circuit breaker protection"""
    from main import StockDataIngestion
    
    # Mock database
    ingestion = StockDataIngestion("postgresql://test")
    ingestion.pool = AsyncMock()
    
    # Mock yfinance to fail
    with patch('main.yf.Ticker') as mock_ticker:
        mock_ticker.side_effect = Exception("API failure")
        
        # Should handle the failure gracefully
        with pytest.raises(Exception):
            await ingestion.fetch_stock_data_yfinance("CBA", date.today() - timedelta(days=30), date.today())
        
        # Check circuit breaker state
        metrics = ingestion.circuit_breaker.get_metrics()
        assert metrics["failure_count"] > 0


if __name__ == "__main__":
    # Run basic tests
    asyncio.run(test_stock_ingestion_with_circuit_breaker())
    print("✅ Circuit breaker tests passed!")