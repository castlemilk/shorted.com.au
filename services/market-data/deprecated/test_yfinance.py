#!/usr/bin/env python3
"""
Test yfinance connectivity for ASX stocks
"""
import yfinance as yf
from datetime import date, timedelta

def test_single_stock():
    """Test fetching data for a single ASX stock"""
    print("🧪 Testing yfinance with WOW.AX...")
    
    try:
        # Test WOW (Woolworths)
        ticker = yf.Ticker("WOW.AX")
        
        # Get 1 month of data for testing
        end_date = date.today()
        start_date = end_date - timedelta(days=30)
        
        print(f"Fetching data from {start_date} to {end_date}...")
        hist = ticker.history(start=start_date, end=end_date)
        
        if hist.empty:
            print("❌ No data returned")
            return False
        
        print(f"✅ Successfully fetched {len(hist)} records")
        print("\n📊 Sample data:")
        print(hist.head().to_string())
        
        print(f"\n📈 Latest price: ${hist['Close'].iloc[-1]:.2f}")
        print(f"📅 Date range: {hist.index[0].date()} to {hist.index[-1].date()}")
        
        return True
        
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

def test_multiple_stocks():
    """Test a few ASX stocks"""
    test_stocks = ['WOW.AX', 'CBA.AX', 'BHP.AX']
    
    print(f"\n🧪 Testing multiple stocks: {test_stocks}")
    
    for stock in test_stocks:
        print(f"\nTesting {stock}...")
        try:
            ticker = yf.Ticker(stock)
            hist = ticker.history(period='5d')
            
            if not hist.empty:
                latest = hist['Close'].iloc[-1]
                print(f"  ✅ {stock}: ${latest:.2f} ({len(hist)} records)")
            else:
                print(f"  ⚠️  {stock}: No data")
        except Exception as e:
            print(f"  ❌ {stock}: {e}")

if __name__ == "__main__":
    test_single_stock()
    test_multiple_stocks()