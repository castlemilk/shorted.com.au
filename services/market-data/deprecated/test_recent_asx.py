"""
Test Alpha Vantage with stocks that have recent data.
"""

import asyncio
import sys
import os

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from data_providers.factory import DataProviderFactory

async def test_recent_asx_stocks():
    """Test Alpha Vantage with ASX stocks that have recent data."""
    print("🧪 Testing Alpha Vantage with Recent ASX Stocks")
    print("=" * 60)
    
    # Create provider
    provider = DataProviderFactory.create_provider(
        "alpha_vantage", 
        api_key="UOI9AM59F03A0WZC"
    )
    
    # Test stocks that had recent data in our previous test
    test_symbols = [
        "BHP.AX",  # BHP Group
        "RIO.AX",  # Rio Tinto  
        "TLS.AX",  # Telstra
        "WOW.AX",  # Woolworths
        "WES.AX",  # Wesfarmers
        "CSL.AX",  # CSL Limited
    ]
    
    try:
        async with provider as p:
            results = await p.fetch_multiple_symbols(test_symbols)
            
            print(f"✅ Fetched data for {len(results)}/{len(test_symbols)} symbols")
            
            for symbol, df in results.items():
                if df is not None and not df.empty:
                    latest_date = df.index.max().date()
                    latest_close = df['Close'].iloc[-1]
                    print(f"   📊 {symbol}: {len(df)} records, latest: {latest_date} @ ${latest_close:.2f}")
                else:
                    print(f"   ❌ {symbol}: No data")
                    
    except Exception as e:
        print(f"❌ Error: {e}")
        return False
    
    return True

if __name__ == "__main__":
    success = asyncio.run(test_recent_asx_stocks())
    sys.exit(0 if success else 1)

