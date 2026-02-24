"""
Test script for Alpha Vantage integration.

This script tests the Alpha Vantage data provider locally before deployment.
"""

import asyncio
import os
import sys
from datetime import date, timedelta

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from data_providers.factory import DataProviderFactory
from data_providers.alpha_vantage import AlphaVantageProvider

async def test_alpha_vantage_provider():
    """Test Alpha Vantage provider functionality."""
    print("🧪 Testing Alpha Vantage Provider")
    print("=" * 50)
    
    # Test provider creation
    try:
        provider = DataProviderFactory.create_provider(
            "alpha_vantage", 
            api_key=os.environ["ALPHA_VANTAGE_API_KEY"]
        )
        print(f"✅ Provider created: {provider.get_provider_name()}")
        print(f"📊 Rate limit delay: {provider.get_rate_limit_delay()}s")
        print(f"📦 Batch size: {provider.get_batch_size()}")
    except Exception as e:
        print(f"❌ Failed to create provider: {e}")
        return False
    
    # Test single symbol fetch
    print("\n🔍 Testing single symbol fetch...")
    try:
        async with provider as p:
            # Test with a major ASX stock
            df = await p.fetch_historical_data("CBA.AX")
            
            if df is not None and not df.empty:
                print(f"✅ Successfully fetched data for CBA.AX")
                print(f"📈 Records: {len(df)}")
                print(f"📅 Date range: {df.index.min().date()} to {df.index.max().date()}")
                print(f"💰 Latest close: ${df['Close'].iloc[-1]:.2f}")
            else:
                print("❌ No data returned for CBA.AX")
                return False
                
    except Exception as e:
        print(f"❌ Error fetching CBA.AX: {e}")
        return False
    
    # Test multiple symbols fetch
    print("\n🔍 Testing multiple symbols fetch...")
    try:
        async with provider as p:
            test_symbols = ["CBA.AX", "ANZ.AX", "WBC.AX"]
            results = await p.fetch_multiple_symbols(test_symbols)
            
            print(f"✅ Fetched data for {len(results)}/{len(test_symbols)} symbols")
            for symbol, df in results.items():
                print(f"   📊 {symbol}: {len(df)} records")
                
            if len(results) == 0:
                print("❌ No data returned for any symbols")
                return False
                
    except Exception as e:
        print(f"❌ Error fetching multiple symbols: {e}")
        return False
    
    print("\n✅ All tests passed!")
    return True

async def test_provider_factory():
    """Test the provider factory."""
    print("\n🏭 Testing Provider Factory")
    print("=" * 30)
    
    # Test available providers
    providers = DataProviderFactory.get_available_providers()
    print(f"📋 Available providers: {providers}")
    
    # Test default provider
    default = DataProviderFactory.get_default_provider()
    print(f"🎯 Default provider: {default}")
    
    # Test creating different providers
    try:
        alpha_provider = DataProviderFactory.create_provider("alpha_vantage", api_key=os.environ["ALPHA_VANTAGE_API_KEY"])
        print(f"✅ Alpha Vantage provider created: {alpha_provider.get_provider_name()}")
        
        yahoo_provider = DataProviderFactory.create_provider("yahoo_finance")
        print(f"✅ Yahoo Finance provider created: {yahoo_provider.get_provider_name()}")
        
    except Exception as e:
        print(f"❌ Error creating providers: {e}")
        return False
    
    return True

async def main():
    """Main test function."""
    print("🚀 Starting Alpha Vantage Integration Tests")
    print("=" * 60)
    
    # Test provider factory
    factory_success = await test_provider_factory()
    
    # Test Alpha Vantage provider
    alpha_success = await test_alpha_vantage_provider()
    
    print("\n" + "=" * 60)
    if factory_success and alpha_success:
        print("🎉 All tests passed! Ready for deployment.")
        return True
    else:
        print("💥 Some tests failed. Check the errors above.")
        return False

if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)

