"""
Alpha Vantage data provider implementation.

This module implements the StockDataProvider interface for Alpha Vantage API.
Based on documentation: https://www.alphavantage.co/documentation/
"""

import asyncio
import aiohttp
import pandas as pd
from typing import Dict, List, Optional
from datetime import datetime, date, timedelta
import logging
import os
from .base import StockDataProvider, DataProviderError, RateLimitError, SymbolNotFoundError

logger = logging.getLogger(__name__)


class AlphaVantageProvider(StockDataProvider):
    """Alpha Vantage data provider implementation."""
    
    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize Alpha Vantage provider.
        
        Args:
            api_key: Alpha Vantage API key. If None, will try to get from environment.
        """
        self.api_key = api_key or os.getenv('ALPHA_VANTAGE_API_KEY')
        if not self.api_key:
            raise ValueError("Alpha Vantage API key is required")
        
        self.base_url = "https://www.alphavantage.co/query"
        self.session: Optional[aiohttp.ClientSession] = None
        
        # Alpha Vantage rate limits: 5 requests per minute, 500 requests per day
        self.rate_limit_delay = 12.0  # 12 seconds between requests (5 per minute)
        self.batch_size = 10  # Conservative batch size
        
    async def __aenter__(self):
        """Async context manager entry."""
        self.session = aiohttp.ClientSession()
        return self
        
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        if self.session:
            await self.session.close()
    
    def get_rate_limit_delay(self) -> float:
        """Get the recommended delay between API calls."""
        return self.rate_limit_delay
    
    def get_batch_size(self) -> int:
        """Get the recommended batch size."""
        return self.batch_size
    
    def get_provider_name(self) -> str:
        """Get the provider name."""
        return "Alpha Vantage"
    
    async def _make_request(self, params: Dict[str, str]) -> Dict:
        """
        Make a request to Alpha Vantage API.
        
        Args:
            params: API parameters
            
        Returns:
            JSON response data
            
        Raises:
            RateLimitError: If rate limit is exceeded
            DataProviderError: If API request fails
        """
        if not self.session:
            raise DataProviderError("Provider not initialized. Use async context manager.")
        
        params['apikey'] = self.api_key
        
        try:
            async with self.session.get(self.base_url, params=params) as response:
                if response.status == 429:
                    raise RateLimitError("Alpha Vantage rate limit exceeded")
                
                if response.status != 200:
                    raise DataProviderError(f"API request failed with status {response.status}")
                
                data = await response.json()
                
                # Check for API errors in response
                if 'Error Message' in data:
                    raise DataProviderError(f"Alpha Vantage API error: {data['Error Message']}")
                
                if 'Note' in data:
                    logger.warning(f"Alpha Vantage API note: {data['Note']}")
                
                if 'Information' in data:
                    logger.info(f"Alpha Vantage API info: {data['Information']}")
                
                return data
                
        except aiohttp.ClientError as e:
            raise DataProviderError(f"Network error: {e}")
    
    def _convert_symbol_for_alpha_vantage(self, symbol: str) -> str:
        """
        Convert symbol format for Alpha Vantage API.
        
        Alpha Vantage uses different symbol formats:
        - ASX stocks: 'CBA.AX' -> 'CBA' (remove .AX suffix)
        - US stocks: 'IBM' -> 'IBM' (no change)
        
        Args:
            symbol: Original symbol
            
        Returns:
            Symbol formatted for Alpha Vantage
        """
        # Remove .AX suffix for ASX stocks
        if symbol.endswith('.AX'):
            return symbol[:-3]  # Remove last 3 characters (.AX)
        return symbol
    
    def _parse_time_series_data(self, data: Dict, symbol: str) -> Optional[pd.DataFrame]:
        """
        Parse Alpha Vantage time series response into DataFrame.
        
        Args:
            data: API response data
            symbol: Stock symbol
            
        Returns:
            DataFrame with historical data or None if no data
        """
        try:
            # Look for time series data in the response
            time_series_key = None
            for key in data.keys():
                if 'Time Series' in key:
                    time_series_key = key
                    break
            
            if not time_series_key or not data[time_series_key]:
                logger.warning(f"No time series data found for {symbol}")
                return None
            
            time_series = data[time_series_key]
            
            # Convert to DataFrame
            df = pd.DataFrame.from_dict(time_series, orient='index')
            df.index = pd.to_datetime(df.index)
            df.index.name = 'Date'
            
            # Rename columns to match our schema
            column_mapping = {
                '1. open': 'Open',
                '2. high': 'High', 
                '3. low': 'Low',
                '4. close': 'Close',
                '5. volume': 'Volume'
            }
            
            df = df.rename(columns=column_mapping)
            
            # Convert to numeric types
            for col in ['Open', 'High', 'Low', 'Close', 'Volume']:
                if col in df.columns:
                    df[col] = pd.to_numeric(df[col], errors='coerce')
            
            # Sort by date
            df = df.sort_index()
            
            # Filter out any rows with NaN values
            df = df.dropna()
            
            if df.empty:
                logger.warning(f"No valid data after processing for {symbol}")
                return None
            
            logger.info(f"Successfully parsed {len(df)} records for {symbol}")
            return df
            
        except Exception as e:
            logger.error(f"Error parsing time series data for {symbol}: {e}")
            return None
    
    async def fetch_historical_data(
        self, 
        symbol: str, 
        start_date: Optional[date] = None, 
        end_date: Optional[date] = None,
        full_output: bool = True
    ) -> Optional[pd.DataFrame]:
        """
        Fetch historical stock data for a given symbol.
        
        Args:
            symbol: Stock symbol (e.g., 'CBA.AX', 'IBM')
            start_date: Start date for historical data (optional)
            end_date: End date for historical data (optional)
            full_output: If True, fetch full history (~20 years). If False, fetch last 100 points.
            
        Returns:
            DataFrame with columns: ['Date', 'Open', 'High', 'Low', 'Close', 'Volume']
            Returns None if data cannot be fetched
        """
        alpha_symbol = self._convert_symbol_for_alpha_vantage(symbol)
        
        # Use 'full' for complete history (needed for gap filling)
        # 'compact' only returns last 100 data points
        output_size = 'full' if full_output else 'compact'
        
        params = {
            'function': 'TIME_SERIES_DAILY',
            'symbol': alpha_symbol,
            'outputsize': output_size
        }
        
        try:
            logger.info(f"Fetching data for {symbol} ({alpha_symbol}) from Alpha Vantage (outputsize={output_size})")
            data = await self._make_request(params)
            
            df = self._parse_time_series_data(data, symbol)
            
            if df is not None and start_date:
                df = df[df.index.date >= start_date]
            
            if df is not None and end_date:
                df = df[df.index.date <= end_date]
            
            return df
            
        except Exception as e:
            logger.error(f"Failed to fetch data for {symbol}: {e}")
            return None
    
    async def fetch_multiple_symbols(
        self, 
        symbols: List[str], 
        start_date: Optional[date] = None, 
        end_date: Optional[date] = None
    ) -> Dict[str, pd.DataFrame]:
        """
        Fetch historical data for multiple symbols with rate limiting.
        
        Args:
            symbols: List of stock symbols
            start_date: Start date for historical data (optional)
            end_date: End date for historical data (optional)
            
        Returns:
            Dictionary mapping symbol to DataFrame with historical data
        """
        results = {}
        
        logger.info(f"Fetching data for {len(symbols)} symbols from Alpha Vantage")
        
        for i, symbol in enumerate(symbols):
            try:
                df = await self.fetch_historical_data(symbol, start_date, end_date)
                if df is not None:
                    results[symbol] = df
                    logger.info(f"Successfully fetched data for {symbol} ({len(df)} records)")
                else:
                    logger.warning(f"No data available for {symbol}")
                
                # Rate limiting: wait between requests
                if i < len(symbols) - 1:  # Don't wait after the last request
                    logger.debug(f"Waiting {self.rate_limit_delay}s for rate limiting...")
                    await asyncio.sleep(self.rate_limit_delay)
                    
            except Exception as e:
                logger.error(f"Error fetching data for {symbol}: {e}")
                continue
        
        logger.info(f"Completed fetching data: {len(results)}/{len(symbols)} symbols successful")
        return results
