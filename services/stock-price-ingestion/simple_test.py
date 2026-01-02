#!/usr/bin/env python3
"""
Simple test for data fetching using just yfinance
"""
import sys
import subprocess

# Install just yfinance for testing
subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'yfinance', 'requests'])

import yfinance as yf
from datetime import date, timedelta

def test_yfinance_fetch():
    """Test basic yfinance functionality"""
    print("Testing yfinance data fetch...")
    
    try:
        # Test with CBA (Commonwealth Bank of Australia)
        ticker = yf.Ticker("CBA.AX")
        
        # Get 1 week of data
        end_date = date.today()
        start_date = end_date - timedelta(days=7)
        
        print(f"Fetching data for CBA.AX from {start_date} to {end_date}")
        
        hist = ticker.history(start=start_date, end=end_date, interval='1d')
        
        if not hist.empty:
            print(f"✓ Successfully fetched {len(hist)} records")
            print(f"Columns: {list(hist.columns)}")
            print(f"Date range: {hist.index[0].date()} to {hist.index[-1].date()}")
            print("\nSample data:")
            print(hist.head(2))
            
            # Test data validation
            print("\nData validation:")
            print(f"- No negative prices: {(hist['Close'] >= 0).all()}")
            print(f"- High >= Low: {(hist['High'] >= hist['Low']).all()}")
            print(f"- Volume is numeric: {hist['Volume'].dtype in ['int64', 'float64']}")
            
            return True
        else:
            print("✗ No data returned")
            return False
            
    except Exception as e:
        print(f"✗ Error: {e}")
        return False

def test_multiple_stocks():
    """Test fetching multiple ASX stocks"""
    print("\nTesting multiple stock fetch...")
    
    stocks = ['CBA.AX', 'BHP.AX', 'CSL.AX']
    end_date = date.today()
    start_date = end_date - timedelta(days=5)
    
    results = {}
    
    for stock in stocks:
        try:
            ticker = yf.Ticker(stock)
            hist = ticker.history(start=start_date, end=end_date)
            
            if not hist.empty:
                results[stock] = len(hist)
                print(f"✓ {stock}: {len(hist)} records")
            else:
                results[stock] = 0
                print(f"✗ {stock}: No data")
                
        except Exception as e:
            results[stock] = -1
            print(f"✗ {stock}: Error - {e}")
    
    successful = sum(1 for v in results.values() if v > 0)
    print(f"\nSummary: {successful}/{len(stocks)} stocks successful")
    
    return successful > 0

if __name__ == "__main__":
    print("=== Simple yfinance API Test ===\n")
    
    # Test basic functionality
    basic_test = test_yfinance_fetch()
    
    # Test multiple stocks
    multi_test = test_multiple_stocks()
    
    print(f"\n=== Test Results ===")
    print(f"Basic fetch: {'PASS' if basic_test else 'FAIL'}")
    print(f"Multiple stocks: {'PASS' if multi_test else 'FAIL'}")
    
    if basic_test and multi_test:
        print("\n✓ All tests passed! The data fetching should work.")
    else:
        print("\n✗ Some tests failed. Check your internet connection and yfinance API.")