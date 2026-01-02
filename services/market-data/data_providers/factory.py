"""
Data provider factory for creating stock data providers.

This module provides a factory pattern for creating different types of stock data providers.
"""

from typing import Optional
from .base import StockDataProvider
from .alpha_vantage import AlphaVantageProvider
from .yahoo_finance import YahooFinanceProvider


class DataProviderFactory:
    """Factory for creating stock data providers."""
    
    @staticmethod
    def create_provider(provider_type: str, **kwargs) -> StockDataProvider:
        """
        Create a stock data provider instance.
        
        Args:
            provider_type: Type of provider ('alpha_vantage', 'yahoo_finance')
            **kwargs: Additional arguments for provider initialization
            
        Returns:
            StockDataProvider instance
            
        Raises:
            ValueError: If provider_type is not supported
        """
        provider_type = provider_type.lower()
        
        if provider_type == 'alpha_vantage':
            return AlphaVantageProvider(**kwargs)
        elif provider_type == 'yahoo_finance':
            return YahooFinanceProvider(**kwargs)
        else:
            raise ValueError(f"Unsupported provider type: {provider_type}")
    
    @staticmethod
    def get_available_providers() -> list[str]:
        """
        Get list of available provider types.
        
        Returns:
            List of available provider type names
        """
        return ['alpha_vantage', 'yahoo_finance']
    
    @staticmethod
    def get_default_provider() -> str:
        """
        Get the default provider type.
        
        Returns:
            Default provider type name
        """
        return 'alpha_vantage'

