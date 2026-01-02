#!/usr/bin/env python3
"""
Test script for the enhanced historical data processor with Alpha Vantage integration.

This script tests the Alpha Vantage provider and the enhanced processor functionality.
"""

import asyncio
import os
import sys
import logging
from datetime import date, timedelta

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from data_providers.factory import DataProviderFactory
from data_providers.alpha_vantage import AlphaVantageProvider
from data_providers.yahoo_finance import YahooFinanceProvider
from enhanced_historical_processor import EnhancedStockDataProcessor

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Test configuration
ALPHA_VANTAGE_API_KEY = "UOI9AM59F03A0WZC"
TEST_SYMBOLS = ["CBA.AX", "ANZ.AX", "WBC.AX"]


async def test_alpha_vantage_provider():
    """Test Alpha Vantage provider functionality."""
    logger.info("🧪 Testing Alpha Vantage Provider")
    logger.info("=" * 50)

    # Test provider creation
    try:
        provider = DataProviderFactory.create_provider(
            "alpha_vantage", api_key=ALPHA_VANTAGE_API_KEY
        )
        logger.info(f"✅ Provider created: {provider.get_provider_name()}")
        logger.info(f"📊 Rate limit delay: {provider.get_rate_limit_delay()}s")
        logger.info(f"📦 Batch size: {provider.get_batch_size()}")
    except Exception as e:
        logger.error(f"❌ Failed to create provider: {e}")
        return False

    # Test single symbol fetch
    logger.info("\n🔍 Testing single symbol fetch...")
    try:
        async with provider as p:
            # Test with a major ASX stock
            df = await p.fetch_historical_data("CBA.AX")

            if df is not None and not df.empty:
                logger.info(f"✅ Successfully fetched data for CBA.AX")
                logger.info(f"📈 Records: {len(df)}")
                logger.info(
                    f"📅 Date range: {df.index.min().date()} to {df.index.max().date()}"
                )
                logger.info(f"💰 Latest close: ${df['Close'].iloc[-1]:.2f}")
                logger.info(f"📊 Columns: {list(df.columns)}")
            else:
                logger.error("❌ No data returned for CBA.AX")
                return False

    except Exception as e:
        logger.error(f"❌ Error fetching CBA.AX: {e}")
        return False

    # Test multiple symbols fetch
    logger.info("\n🔍 Testing multiple symbols fetch...")
    try:
        async with provider as p:
            results = await p.fetch_multiple_symbols(TEST_SYMBOLS)

            logger.info(
                f"✅ Fetched data for {len(results)}/{len(TEST_SYMBOLS)} symbols"
            )
            for symbol, df in results.items():
                logger.info(f"   📊 {symbol}: {len(df)} records")

            if len(results) == 0:
                logger.error("❌ No data returned for any symbols")
                return False

    except Exception as e:
        logger.error(f"❌ Error fetching multiple symbols: {e}")
        return False

    logger.info("\n✅ Alpha Vantage tests passed!")
    return True


async def test_yahoo_finance_provider():
    """Test Yahoo Finance provider functionality."""
    logger.info("\n🧪 Testing Yahoo Finance Provider")
    logger.info("=" * 50)

    try:
        provider = DataProviderFactory.create_provider("yahoo_finance")
        logger.info(f"✅ Provider created: {provider.get_provider_name()}")

        # Test single symbol fetch
        df = await provider.fetch_historical_data("CBA.AX")

        if df is not None and not df.empty:
            logger.info(f"✅ Successfully fetched data for CBA.AX")
            logger.info(f"📈 Records: {len(df)}")
            logger.info(
                f"📅 Date range: {df.index.min().date()} to {df.index.max().date()}"
            )
            logger.info(f"💰 Latest close: ${df['Close'].iloc[-1]:.2f}")
        else:
            logger.error("❌ No data returned for CBA.AX")
            return False

    except Exception as e:
        logger.error(f"❌ Error testing Yahoo Finance: {e}")
        return False

    logger.info("✅ Yahoo Finance tests passed!")
    return True


async def test_enhanced_processor():
    """Test the enhanced processor with fallback functionality."""
    logger.info("\n🧪 Testing Enhanced Processor")
    logger.info("=" * 50)

    try:
        processor = EnhancedStockDataProcessor()

        # Test single stock data fetch with fallback
        logger.info("🔍 Testing single stock fetch with fallback...")
        df = await processor.fetch_stock_data_with_fallback("CBA.AX", years=1)

        if df is not None and not df.empty:
            logger.info(f"✅ Enhanced processor success for CBA.AX")
            logger.info(f"📈 Records: {len(df)}")
            logger.info(
                f"📅 Date range: {df.index.min().date()} to {df.index.max().date()}"
            )

            # Test record conversion
            records = processor.convert_dataframe_to_records(df, "CBA")
            logger.info(f"📊 Converted to {len(records)} database records")

            if records:
                sample_record = records[0]
                logger.info(f"📋 Sample record: {sample_record}")
        else:
            logger.error("❌ Enhanced processor failed for CBA.AX")
            return False

    except Exception as e:
        logger.error(f"❌ Error testing enhanced processor: {e}")
        return False

    logger.info("✅ Enhanced processor tests passed!")
    return True


async def test_provider_factory():
    """Test the provider factory."""
    logger.info("\n🏭 Testing Provider Factory")
    logger.info("=" * 30)

    # Test available providers
    providers = DataProviderFactory.get_available_providers()
    logger.info(f"📋 Available providers: {providers}")

    # Test default provider
    default = DataProviderFactory.get_default_provider()
    logger.info(f"🎯 Default provider: {default}")

    # Test creating different providers
    try:
        alpha_provider = DataProviderFactory.create_provider(
            "alpha_vantage", api_key=ALPHA_VANTAGE_API_KEY
        )
        logger.info(
            f"✅ Alpha Vantage provider created: {alpha_provider.get_provider_name()}"
        )

        yahoo_provider = DataProviderFactory.create_provider("yahoo_finance")
        logger.info(
            f"✅ Yahoo Finance provider created: {yahoo_provider.get_provider_name()}"
        )

    except Exception as e:
        logger.error(f"❌ Error creating providers: {e}")
        return False

    return True


async def main():
    """Main test function."""
    logger.info("🚀 Starting Enhanced Historical Data Processor Tests")
    logger.info("=" * 70)

    # Test provider factory
    factory_success = await test_provider_factory()

    # Test Alpha Vantage provider
    alpha_success = await test_alpha_vantage_provider()

    # Test Yahoo Finance provider
    yahoo_success = await test_yahoo_finance_provider()

    # Test enhanced processor
    processor_success = await test_enhanced_processor()

    logger.info("\n" + "=" * 70)
    if factory_success and alpha_success and yahoo_success and processor_success:
        logger.info("🎉 All tests passed! Enhanced processor is ready for deployment.")
        return True
    else:
        logger.error("💥 Some tests failed. Check the errors above.")
        return False


if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)
