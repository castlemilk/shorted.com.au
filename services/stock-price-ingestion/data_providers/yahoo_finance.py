"""
Yahoo Finance data provider implementation.

This module implements the StockDataProvider interface for Yahoo Finance using yfinance.
"""

import asyncio
import pandas as pd
from typing import Dict, List, Optional
from datetime import datetime, date, timedelta
import logging
import yfinance as yf
from .base import StockDataProvider, DataProviderError, RateLimitError, SymbolNotFoundError

logger = logging.getLogger(__name__)


class YahooFinanceProvider(StockDataProvider):
    """Yahoo Finance data provider implementation."""
    
    def __init__(self):
        """Initialize Yahoo Finance provider."""
        # Yahoo Finance rate limits are less strict but we'll be conservative
        self.rate_limit_delay = 2.0  # 2 seconds between requests
        self.batch_size = 20  # Can handle larger batches
        
    def get_rate_limit_delay(self) -> float:
        """Get the recommended delay between API calls."""
        return self.rate_limit_delay
    
    def get_batch_size(self) -> int:
        """Get the recommended batch size."""
        return self.batch_size
    
    def get_provider_name(self) -> str:
        """Get the provider name."""
        return "Yahoo Finance"
    
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
        try:
            logger.info(f"Fetching data for {symbol} from Yahoo Finance")
            
            ticker = yf.Ticker(symbol)
            
            # Convert dates to strings for yfinance
            start_str = start_date.strftime('%Y-%m-%d') if start_date else None
            end_str = end_date.strftime('%Y-%m-%d') if end_date else None
            
            # Fetch historical data
            df = ticker.history(start=start_str, end=end_str)
            
            if df.empty:
                logger.warning(f"No data available for {symbol}")
                return None
            
            # Rename columns to match our schema
            df = df.rename(columns={
                'Open': 'Open',
                'High': 'High',
                'Low': 'Low', 
                'Close': 'Close',
                'Volume': 'Volume'
            })
            
            # Ensure we have the required columns
            required_cols = ['Open', 'High', 'Low', 'Close', 'Volume']
            if not all(col in df.columns for col in required_cols):
                logger.warning(f"Missing required columns for {symbol}")
                return None
            
            # Convert index to datetime if it isn't already
            if not isinstance(df.index, pd.DatetimeIndex):
                df.index = pd.to_datetime(df.index)
            
            df.index.name = 'Date'
            
            # Filter out any rows with NaN values
            df = df.dropna()
            
            if df.empty:
                logger.warning(f"No valid data after processing for {symbol}")
                return None
            
            logger.info(f"Successfully fetched {len(df)} records for {symbol}")
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
        
        logger.info(f"Fetching data for {len(symbols)} symbols from Yahoo Finance")
        
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

