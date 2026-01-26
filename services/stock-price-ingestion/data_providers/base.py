"""
Abstract base class for stock data providers.

This module defines the interface that all stock data providers must implement,
enabling a pluggable architecture for different data sources.
"""

from abc import ABC, abstractmethod
from typing import Dict, List, Optional, Any
from datetime import datetime, date
import pandas as pd


class StockDataProvider(ABC):
    """Abstract base class for stock data providers."""
    
    @abstractmethod
    async def fetch_historical_data(
        self, 
        symbol: str, 
        start_date: Optional[date] = None, 
        end_date: Optional[date] = None
    ) -> Optional[pd.DataFrame]:
        """
        Fetch historical stock data for a given symbol.
        
        Args:
            symbol: Stock symbol (e.g., 'CBA.AX', 'IBM')
            start_date: Start date for historical data (optional)
            end_date: End date for historical data (optional)
            
        Returns:
            DataFrame with columns: ['Date', 'Open', 'High', 'Low', 'Close', 'Volume']
            Returns None if data cannot be fetched
        """
        pass
    
    @abstractmethod
    async def fetch_multiple_symbols(
        self, 
        symbols: List[str], 
        start_date: Optional[date] = None, 
        end_date: Optional[date] = None
    ) -> Dict[str, pd.DataFrame]:
        """
        Fetch historical data for multiple symbols.
        
        Args:
            symbols: List of stock symbols
            start_date: Start date for historical data (optional)
            end_date: End date for historical data (optional)
            
        Returns:
            Dictionary mapping symbol to DataFrame with historical data
        """
        pass
    
    @abstractmethod
    def get_rate_limit_delay(self) -> float:
        """
        Get the recommended delay between API calls to respect rate limits.
        
        Returns:
            Delay in seconds
        """
        pass
    
    @abstractmethod
    def get_batch_size(self) -> int:
        """
        Get the recommended batch size for processing multiple symbols.
        
        Returns:
            Number of symbols to process in each batch
        """
        pass
    
    @abstractmethod
    def get_provider_name(self) -> str:
        """
        Get the name of this data provider.
        
        Returns:
            Provider name string
        """
        pass


class DataProviderError(Exception):
    """Exception raised when data provider encounters an error."""
    pass


class RateLimitError(DataProviderError):
    """Exception raised when rate limit is exceeded."""
    pass


class SymbolNotFoundError(DataProviderError):
    """Exception raised when a symbol is not found."""
    pass

