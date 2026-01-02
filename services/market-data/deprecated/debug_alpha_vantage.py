"""
Debug script to check Alpha Vantage API responses.
"""

import asyncio
import aiohttp
import json

async def debug_alpha_vantage_api():
    """Debug Alpha Vantage API responses."""
    api_key = "UOI9AM59F03A0WZC"
    base_url = "https://www.alphavantage.co/query"
    
    # Test different symbol formats
    test_symbols = [
        "CBA.AX",  # ASX format
        "CBA",     # Without .AX
        "IBM",     # US stock
        "AAPL"     # Another US stock
    ]
    
    async with aiohttp.ClientSession() as session:
        for symbol in test_symbols:
            print(f"\n🔍 Testing symbol: {symbol}")
            print("-" * 40)
            
            params = {
                'function': 'TIME_SERIES_DAILY',
                'symbol': symbol,
                'outputsize': 'compact',
                'apikey': api_key
            }
            
            try:
                async with session.get(base_url, params=params) as response:
                    print(f"Status: {response.status}")
                    
                    if response.status == 200:
                        data = await response.json()
                        
                        # Print all keys in the response
                        print(f"Response keys: {list(data.keys())}")
                        
                        # Check for errors
                        if 'Error Message' in data:
                            print(f"❌ Error: {data['Error Message']}")
                        elif 'Note' in data:
                            print(f"⚠️ Note: {data['Note']}")
                        elif 'Information' in data:
                            print(f"ℹ️ Info: {data['Information']}")
                        else:
                            # Look for time series data
                            time_series_key = None
                            for key in data.keys():
                                if 'Time Series' in key:
                                    time_series_key = key
                                    break
                            
                            if time_series_key:
                                time_series = data[time_series_key]
                                print(f"✅ Found time series data: {time_series_key}")
                                print(f"📊 Records: {len(time_series)}")
                                
                                # Show first few records
                                if time_series:
                                    first_date = list(time_series.keys())[0]
                                    print(f"📅 Latest date: {first_date}")
                                    print(f"💰 Latest close: {time_series[first_date]['4. close']}")
                            else:
                                print("❌ No time series data found")
                                print(f"Full response: {json.dumps(data, indent=2)[:500]}...")
                    else:
                        print(f"❌ HTTP Error: {response.status}")
                        
            except Exception as e:
                print(f"❌ Exception: {e}")
            
            # Wait between requests to respect rate limits
            await asyncio.sleep(12)

if __name__ == "__main__":
    asyncio.run(debug_alpha_vantage_api())

