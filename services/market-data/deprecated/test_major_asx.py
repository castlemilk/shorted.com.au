"""
Test major ASX stocks without .AX suffix.
"""

import asyncio
import aiohttp
import json

async def test_major_asx_stocks():
    """Test major ASX stocks without .AX suffix."""
    api_key = "UOI9AM59F03A0WZC"
    base_url = "https://www.alphavantage.co/query"
    
    # Major ASX stocks without .AX suffix
    test_symbols = [
        "CBA",    # Commonwealth Bank
        "ANZ",    # ANZ Bank
        "WBC",    # Westpac
        "NAB",    # NAB
        "BHP",    # BHP Group
        "RIO",    # Rio Tinto
        "TLS",    # Telstra
        "WOW",    # Woolworths
        "WES",    # Wesfarmers
        "CSL",    # CSL Limited
    ]
    
    async with aiohttp.ClientSession() as session:
        for symbol in test_symbols:
            print(f"\n🔍 Testing ASX stock: {symbol}")
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
                                    last_date = list(time_series.keys())[-1]
                                    print(f"📅 Date range: {last_date} to {first_date}")
                                    print(f"💰 Latest close: {time_series[first_date]['4. close']}")
                                    
                                    # Check if data is recent (within last 2 years)
                                    from datetime import datetime
                                    latest_date = datetime.strptime(first_date, '%Y-%m-%d').date()
                                    today = datetime.now().date()
                                    days_old = (today - latest_date).days
                                    
                                    if days_old < 730:  # Less than 2 years
                                        print(f"✅ Recent data ({days_old} days old)")
                                    else:
                                        print(f"⚠️ Old data ({days_old} days old)")
                            else:
                                print("❌ No time series data found")
                    else:
                        print(f"❌ HTTP Error: {response.status}")
                        
            except Exception as e:
                print(f"❌ Exception: {e}")
            
            # Wait between requests to respect rate limits
            await asyncio.sleep(12)

if __name__ == "__main__":
    asyncio.run(test_major_asx_stocks())

