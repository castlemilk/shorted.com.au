#!/usr/bin/env python3
"""
Dynamic ASX Stock Discovery and Symbol Resolution System.

This module provides functionality to:
1. Load all ASX stocks from the PostgreSQL database (source of truth)
2. Resolve ASX stock symbols to different API formats (Alpha Vantage, Yahoo Finance)
3. Support dynamic discovery of any ASX stock
"""

import os
import asyncpg
import logging
from typing import Dict, List, Optional, Set, Tuple
from datetime import date

logger = logging.getLogger(__name__)

# Database connection
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")


class ASXStockResolver:
    """Resolver for ASX stock symbols across different data providers."""

    def __init__(self):
        """Initialize the ASX stock resolver."""
        self.stock_symbols: Set[str] = set()
        self.stock_info_cache: Dict[str, Dict] = {}
        self._initialized = False
        # Start with fallback stocks, will be updated when database is available
        self._load_fallback_stocks()

    async def initialize(self):
        """Initialize the resolver with database data."""
        if not self._initialized:
            await self._load_stocks_from_db()
            self._initialized = True

    async def _load_stocks_from_db(self):
        """Load ASX stocks from the PostgreSQL database."""
        try:
            conn = await asyncpg.connect(DATABASE_URL)

            # Get all unique stock codes from the database
            stock_codes = await conn.fetch(
                "SELECT DISTINCT stock_code FROM stock_prices ORDER BY stock_code"
            )

            # Extract stock symbols
            self.stock_symbols = {row["stock_code"] for row in stock_codes}

            # Get additional stock information if available
            try:
                # Try to get stock info from a companies table if it exists
                stock_info = await conn.fetch(
                    """
                    SELECT stock_code, company_name, industry, market_cap 
                    FROM companies 
                    WHERE stock_code = ANY($1)
                """,
                    list(self.stock_symbols),
                )

                for row in stock_info:
                    self.stock_info_cache[row["stock_code"]] = {
                        "company_name": row["company_name"],
                        "industry": row["industry"],
                        "market_cap": row["market_cap"],
                    }
            except Exception as e:
                logger.info(f"No companies table found, using basic stock info: {e}")
                # If no companies table, create basic info from stock_prices
                for stock_code in self.stock_symbols:
                    stats = await conn.fetchrow(
                        """
                        SELECT COUNT(*) as records, MIN(date) as earliest, MAX(date) as latest
                        FROM stock_prices 
                        WHERE stock_code = $1
                    """,
                        stock_code,
                    )

                    self.stock_info_cache[stock_code] = {
                        "company_name": f"{stock_code} Ltd",
                        "industry": "Unknown",
                        "market_cap": None,
                        "records": stats["records"],
                        "earliest": stats["earliest"],
                        "latest": stats["latest"],
                    }

            await conn.close()

            logger.info(f"✅ Loaded {len(self.stock_symbols)} ASX stocks from database")

        except Exception as e:
            logger.error(f"❌ Failed to load stocks from database: {e}")
            logger.info("Using fallback static list of major ASX stocks")
            self._load_fallback_stocks()

    def _load_fallback_stocks(self):
        """Load fallback static list of major ASX stocks."""
        major_stocks = [
            "CBA",
            "ANZ",
            "WBC",
            "NAB",
            "BHP",
            "RIO",
            "CSL",
            "TLS",
            "FMG",
            "STO",
            "WOW",
            "WES",
            "AGL",
            "ORG",
            "TCL",
            "GPT",
            "SCG",
            "CWN",
            "QAN",
            "FLT",
            "ALL",
            "AMC",
            "APA",
            "ASX",
            "A2M",
            "BXB",
            "CAR",
            "CIM",
            "CPU",
            "DMP",
            "EVT",
            "FPH",
            "GMA",
            "GUD",
            "HUB",
            "IEL",
            "JBH",
            "LLC",
            "MGR",
            "NCM",
            "NST",
            "OSH",
            "PLS",
            "QBE",
            "REA",
            "RHC",
            "S32",
            "SUN",
            "TWE",
            "VEA",
        ]
        self.stock_symbols = set(major_stocks)
        logger.info(
            f"Using fallback list of {len(self.stock_symbols)} major ASX stocks"
        )

    def get_all_stock_symbols(self) -> Set[str]:
        """Get all available ASX stock symbols."""
        return self.stock_symbols.copy()

    def is_valid_asx_symbol(self, symbol: str) -> bool:
        """Check if a symbol is a valid ASX stock."""
        return symbol.upper() in self.stock_symbols

    def get_stock_info(self, symbol: str) -> Optional[Dict]:
        """Get detailed information for a specific stock."""
        symbol_upper = symbol.upper()
        return self.stock_info_cache.get(symbol_upper)

    def resolve_symbols_for_providers(self, symbol: str) -> Tuple[str, str]:
        """
        Resolve ASX symbol to different provider formats.

        Args:
            symbol: ASX stock symbol (e.g., 'CBA')

        Returns:
            Tuple of (alpha_vantage_symbol, yahoo_finance_symbol)
        """
        symbol_upper = symbol.upper()

        # Alpha Vantage uses ASX symbols directly
        alpha_symbol = symbol_upper

        # Yahoo Finance requires .AX suffix
        yahoo_symbol = f"{symbol_upper}.AX"

        return alpha_symbol, yahoo_symbol

    def get_top_stocks_by_market_cap(self, limit: int = 50) -> List[str]:
        """
        Get top stocks by market cap.

        Args:
            limit: Maximum number of stocks to return

        Returns:
            List of stock symbols sorted by market cap (descending)
        """
        # Sort stocks by market cap if available, otherwise by record count
        stocks_with_info = []
        for symbol in self.stock_symbols:
            info = self.stock_info_cache.get(symbol, {})
            market_cap = info.get("market_cap")
            records = info.get("records", 0)

            # Use market cap if available, otherwise use record count as proxy
            sort_key = market_cap if market_cap is not None else records
            stocks_with_info.append((symbol, sort_key))

        # Sort by sort key (descending) and return symbols
        stocks_with_info.sort(key=lambda x: x[1], reverse=True)
        return [symbol for symbol, _ in stocks_with_info[:limit]]

    def get_symbols_by_industry(self, industry: str) -> List[str]:
        """
        Get stocks filtered by industry.

        Args:
            industry: Industry name to filter by

        Returns:
            List of stock symbols in the specified industry
        """
        industry_lower = industry.lower()
        matching_stocks = []

        for symbol in self.stock_symbols:
            info = self.stock_info_cache.get(symbol, {})
            stock_industry = info.get("industry", "").lower()

            if industry_lower in stock_industry:
                matching_stocks.append(symbol)

        return sorted(matching_stocks)

    def search_stocks(self, query: str) -> List[str]:
        """
        Search stocks by company name or symbol.

        Args:
            query: Search query

        Returns:
            List of matching stock symbols
        """
        query_lower = query.lower()
        matching_stocks = []

        for symbol in self.stock_symbols:
            info = self.stock_info_cache.get(symbol, {})
            company_name = info.get("company_name", "").lower()

            # Match by symbol or company name
            if query_lower in symbol.lower() or query_lower in company_name:
                matching_stocks.append(symbol)

        return sorted(matching_stocks)

    def get_stock_count(self) -> int:
        """Get total number of available stocks."""
        return len(self.stock_symbols)

    def refresh_stocks(self):
        """Refresh stock list from database."""
        import asyncio

        asyncio.create_task(self._load_stocks_from_db())


class DynamicASXProcessor:
    """Dynamic processor for ASX stocks using database as source of truth."""

    def __init__(self):
        """Initialize the dynamic processor."""
        self.resolver = ASXStockResolver()

    def get_available_stocks(self) -> Set[str]:
        """Get all available ASX stocks."""
        return self.resolver.get_all_stock_symbols()

    def get_top_stocks(self, limit: int = 50) -> List[str]:
        """Get top stocks by market cap."""
        return self.resolver.get_top_stocks_by_market_cap(limit)

    def is_valid_stock(self, symbol: str) -> bool:
        """Check if a stock symbol is valid."""
        return self.resolver.is_valid_asx_symbol(symbol)

    def validate_stock_symbol(self, symbol: str) -> bool:
        """Validate stock symbol (alias for is_valid_stock)."""
        return self.is_valid_stock(symbol)

    def get_stock_info(self, symbol: str) -> Optional[Dict]:
        """Get stock information."""
        return self.resolver.get_stock_info(symbol)

    def resolve_symbols_for_providers(self, symbol: str) -> Tuple[str, str]:
        """Resolve symbols for different providers."""
        return self.resolver.resolve_symbols_for_providers(symbol)


# For backward compatibility
def get_asx_stock_resolver() -> ASXStockResolver:
    """Get a new instance of ASX stock resolver."""
    return ASXStockResolver()


if __name__ == "__main__":
    # Test the resolver
    import asyncio

    async def test_resolver():
        resolver = ASXStockResolver()
        print(f"Total stocks: {resolver.get_stock_count()}")
        print(f"Top 10 stocks: {resolver.get_top_stocks_by_market_cap(10)}")

        # Test symbol resolution
        test_symbol = "CBA"
        alpha, yahoo = resolver.resolve_symbols_for_providers(test_symbol)
        print(f"{test_symbol} -> Alpha: {alpha}, Yahoo: {yahoo}")

        # Test stock info
        info = resolver.get_stock_info(test_symbol)
        print(f"{test_symbol} info: {info}")

    asyncio.run(test_resolver())
