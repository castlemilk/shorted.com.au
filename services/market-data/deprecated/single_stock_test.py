#!/usr/bin/env python3
"""
Test fetching 10 years of data for a single stock
"""
import yfinance as yf
from datetime import date, timedelta

def test_single_stock_10_years():
    """Test fetching 10 years of data for WOW"""
    print("🧪 Testing 10 years of WOW data...")
    
    try:
        ticker = yf.Ticker("WOW.AX")
        
        # Get 10 years of data
        end_date = date.today()
        start_date = end_date - timedelta(days=10 * 365)
        
        print(f"📅 Fetching from {start_date} to {end_date}...")
        
        import time
        start_time = time.time()
        
        hist = ticker.history(start=start_date, end=end_date)
        
        fetch_time = time.time() - start_time
        
        if hist.empty:
            print("❌ No data returned")
            return
        
        print(f"✅ Successfully fetched {len(hist)} records in {fetch_time:.1f} seconds")
        print(f"📅 Date range: {hist.index[0].date()} to {hist.index[-1].date()}")
        print(f"📊 Years of data: {(hist.index[-1] - hist.index[0]).days / 365.25:.1f}")
        
        # Show first and last few records
        print(f"\n📈 First 5 records:")
        print(hist.head()[['Open', 'High', 'Low', 'Close', 'Volume']].to_string())
        
        print(f"\n📈 Last 5 records:")
        print(hist.tail()[['Open', 'High', 'Low', 'Close', 'Volume']].to_string())
        
        # Show some stats
        print(f"\n📊 Statistics:")
        print(f"Average daily volume: {hist['Volume'].mean():,.0f}")
        print(f"Price range: ${hist['Close'].min():.2f} - ${hist['Close'].max():.2f}")
        print(f"Current price: ${hist['Close'].iloc[-1]:.2f}")
        
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    test_single_stock_10_years()