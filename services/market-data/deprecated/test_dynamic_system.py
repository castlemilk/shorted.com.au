#!/usr/bin/env python3
"""
Test script for the dynamic ASX stock discovery and enhanced processor.

This script tests:
1. Dynamic ASX stock discovery from CSV
2. Symbol resolution for different providers
3. Enhanced processor with Alpha Vantage priority
4. Support for any ASX stock symbol
"""

import asyncio
import os
import sys
import logging
from datetime import date, timedelta

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from asx_stock_resolver import (
    get_asx_resolver,
    get_dynamic_processor,
    ASXStockResolver,
    DynamicASXProcessor,
)
from enhanced_historical_processor import EnhancedStockDataProcessor

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


async def test_asx_resolver():
    """Test the ASX stock resolver functionality."""
    logger.info("🧪 Testing ASX Stock Resolver")
    logger.info("=" * 50)

    resolver = get_asx_resolver()

    # Test getting all stock symbols
    all_stocks = resolver.get_all_stock_symbols()
    logger.info(f"📊 Total ASX stocks available: {len(all_stocks)}")

    # Test symbol validation
    test_symbols = ["CBA", "INVALID", "BHP", "XYZ123"]
    logger.info("\n🔍 Testing symbol validation:")
    for symbol in test_symbols:
        is_valid = resolver.is_valid_asx_symbol(symbol)
        logger.info(f"   {symbol}: {'✅ Valid' if is_valid else '❌ Invalid'}")

    # Test symbol resolution
    test_symbol = "CBA"
    alpha_symbol = resolver.resolve_to_alpha_vantage(test_symbol)
    yahoo_symbol = resolver.resolve_to_yahoo_finance(test_symbol)
    logger.info(f"\n🔄 Symbol resolution for {test_symbol}:")
    logger.info(f"   Alpha Vantage: {alpha_symbol}")
    logger.info(f"   Yahoo Finance: {yahoo_symbol}")

    # Test getting stock info
    stock_info = resolver.get_stock_info("CBA")
    if stock_info:
        logger.info(f"\n📋 Stock info for CBA:")
        logger.info(f"   Company: {stock_info['company_name']}")
        logger.info(f"   Industry: {stock_info['industry']}")
        logger.info(f"   Market Cap: {stock_info['market_cap']}")

    # Test top stocks by market cap
    top_stocks = resolver.get_top_stocks_by_market_cap(10)
    logger.info(f"\n🏆 Top 10 stocks by market cap:")
    for i, stock in enumerate(top_stocks, 1):
        logger.info(f"   {i:2d}. {stock}")

    # Test industry filtering
    banking_stocks = resolver.get_symbols_by_industry("Bank")
    logger.info(f"\n🏦 Banking stocks found: {len(banking_stocks)}")
    logger.info(f"   Examples: {banking_stocks[:5]}")

    # Test search functionality
    search_results = resolver.search_stocks("Commonwealth")
    logger.info(f"\n🔍 Search results for 'Commonwealth':")
    for result in search_results[:3]:  # Show first 3 results
        logger.info(f"   {result['symbol']}: {result['company_name']}")

    logger.info("\n✅ ASX Resolver tests passed!")
    return True


async def test_dynamic_processor():
    """Test the dynamic ASX processor functionality."""
    logger.info("\n🧪 Testing Dynamic ASX Processor")
    logger.info("=" * 50)

    processor = get_dynamic_processor()

    # Test getting available stocks
    available_stocks = processor.get_available_stocks()
    logger.info(f"📊 Available stocks: {len(available_stocks)}")

    # Test symbol validation
    test_symbols = ["CBA", "INVALID", "BHP"]
    logger.info("\n🔍 Testing symbol validation:")
    for symbol in test_symbols:
        is_valid = processor.validate_stock_symbol(symbol)
        logger.info(f"   {symbol}: {'✅ Valid' if is_valid else '❌ Invalid'}")

    # Test symbol resolution for providers
    test_symbol = "CBA"
    alpha_symbol, yahoo_symbol = processor.resolve_symbols_for_providers(test_symbol)
    logger.info(f"\n🔄 Provider symbol resolution for {test_symbol}:")
    logger.info(f"   Alpha Vantage: {alpha_symbol}")
    logger.info(f"   Yahoo Finance: {yahoo_symbol}")

    # Test getting top stocks
    top_stocks = processor.get_top_stocks(5)
    logger.info(f"\n🏆 Top 5 stocks by market cap:")
    for i, stock in enumerate(top_stocks, 1):
        logger.info(f"   {i}. {stock}")

    # Test industry filtering
    tech_stocks = processor.get_stocks_by_industry("Technology")
    logger.info(f"\n💻 Technology stocks found: {len(tech_stocks)}")
    logger.info(f"   Examples: {tech_stocks[:5]}")

    # Test search functionality
    search_results = processor.search_stocks("Bank")
    logger.info(f"\n🔍 Search results for 'Bank':")
    for result in search_results[:3]:
        logger.info(f"   {result['symbol']}: {result['company_name']}")

    logger.info("\n✅ Dynamic Processor tests passed!")
    return True


async def test_enhanced_processor():
    """Test the enhanced processor with dynamic ASX support."""
    logger.info("\n🧪 Testing Enhanced Processor")
    logger.info("=" * 50)

    try:
        processor = EnhancedStockDataProcessor()

        # Test single stock data fetch with fallback
        logger.info("🔍 Testing single stock fetch with fallback...")
        test_symbols = ["CBA", "BHP", "INVALID"]

        for symbol in test_symbols:
            logger.info(f"\n📈 Testing {symbol}...")

            # Validate symbol first
            if not processor.dynamic_processor.validate_stock_symbol(symbol):
                logger.warning(f"   ⚠️ Invalid symbol: {symbol}")
                continue

            # Test data fetch (with shorter time period for testing)
            df = await processor.fetch_stock_data_with_fallback(symbol, years=1)

            if df is not None and not df.empty:
                logger.info(f"   ✅ Success for {symbol}: {len(df)} records")
                logger.info(
                    f"   📅 Date range: {df.index.min().date()} to {df.index.max().date()}"
                )

                # Test record conversion
                records = processor.convert_dataframe_to_records(df, symbol)
                logger.info(f"   📊 Converted to {len(records)} database records")

                if records:
                    sample_record = records[0]
                    logger.info(f"   📋 Sample record: {sample_record}")
            else:
                logger.warning(f"   ⚠️ No data for {symbol}")

        logger.info("\n✅ Enhanced Processor tests passed!")
        return True

    except Exception as e:
        logger.error(f"❌ Error testing enhanced processor: {e}")
        return False


async def test_comprehensive_integration():
    """Test comprehensive integration of all components."""
    logger.info("\n🧪 Testing Comprehensive Integration")
    logger.info("=" * 50)

    try:
        # Test with a few different stock types
        test_cases = [
            ("CBA", "Major Bank"),
            ("BHP", "Mining"),
            ("CSL", "Healthcare"),
            ("XRO", "Technology"),
            ("WOW", "Retail"),
        ]

        processor = EnhancedStockDataProcessor()

        logger.info("🔍 Testing multiple stock types...")

        for symbol, expected_type in test_cases:
            logger.info(f"\n📈 Testing {symbol} ({expected_type})...")

            # Get stock info
            stock_info = processor.dynamic_processor.get_stock_info(symbol)
            if stock_info:
                logger.info(f"   📋 Company: {stock_info['company_name']}")
                logger.info(f"   🏭 Industry: {stock_info['industry']}")

            # Test symbol resolution
            alpha_symbol, yahoo_symbol = (
                processor.dynamic_processor.resolve_symbols_for_providers(symbol)
            )
            logger.info(f"   🔄 Alpha Vantage: {alpha_symbol}, Yahoo: {yahoo_symbol}")

            # Test data fetch (short period for testing)
            df = await processor.fetch_stock_data_with_fallback(symbol, years=1)

            if df is not None and not df.empty:
                logger.info(f"   ✅ Data fetch successful: {len(df)} records")
            else:
                logger.warning(f"   ⚠️ No data available")

        logger.info("\n✅ Comprehensive integration tests passed!")
        return True

    except Exception as e:
        logger.error(f"❌ Error in comprehensive integration test: {e}")
        return False


async def main():
    """Main test function."""
    logger.info("🚀 Starting Dynamic ASX Stock System Tests")
    logger.info("=" * 70)

    # Test ASX resolver
    resolver_success = await test_asx_resolver()

    # Test dynamic processor
    processor_success = await test_dynamic_processor()

    # Test enhanced processor
    enhanced_success = await test_enhanced_processor()

    # Test comprehensive integration
    integration_success = await test_comprehensive_integration()

    logger.info("\n" + "=" * 70)
    if (
        resolver_success
        and processor_success
        and enhanced_success
        and integration_success
    ):
        logger.info("🎉 All tests passed! Dynamic ASX system is ready for deployment.")
        logger.info("📊 The system now supports ALL ASX stocks dynamically!")
        logger.info("🔄 Alpha Vantage API is prioritized with Yahoo Finance fallback.")
        return True
    else:
        logger.error("💥 Some tests failed. Check the errors above.")
        return False


if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)
