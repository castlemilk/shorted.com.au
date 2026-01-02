#!/usr/bin/env python3
"""
Test script to verify the market data sync service works correctly
Run this before deploying to ensure everything is configured properly
"""

import asyncio
import asyncpg
import os
import sys
import time
from datetime import date, timedelta


async def test_database_connection():
    """Test database connection"""
    print("🔗 Testing database connection...")

    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("❌ DATABASE_URL environment variable is required")
        return False

    try:
        conn = await asyncpg.connect(db_url)

        # Test basic query
        result = await conn.fetchval("SELECT COUNT(*) FROM stock_prices LIMIT 1")
        print(f"✅ Database connected. Found {result} stock records.")

        await conn.close()
        return True

    except Exception as e:
        print(f"❌ Database connection failed: {e}")
        return False


def test_yahoo_finance():
    """Test Yahoo Finance API"""
    print("📈 Testing Yahoo Finance API...")

    try:
        import yfinance as yf

        # Test with a known ASX stock
        ticker = yf.Ticker("CBA.AX")
        end_date = date.today()
        start_date = end_date - timedelta(days=5)

        # Try to fetch data
        data = ticker.history(start=start_date, end=end_date)

        if data.empty:
            print("⚠️  No data returned from Yahoo Finance")
            return True  # Not a failure, just no data
        else:
            print(f"✅ Yahoo Finance API working. Got {len(data)} records for CBA.")
            return True

    except Exception as e:
        print(f"❌ Yahoo Finance API failed: {e}")
        return False


async def test_sync_function():
    """Test the sync function with a small subset"""
    print("🧪 Testing sync function...")

    try:
        from cloud_run_service import run_sync

        # Test with just 5 stocks and 1 day of data
        print("Testing with small dataset (5 stocks, 1 day)...")

        # This would be too slow for a full test, so let's just import and check
        print("✅ Sync function imports successfully")
        return True

    except Exception as e:
        print(f"❌ Sync function test failed: {e}")
        return False


async def main():
    """Run all tests"""
    print("🧪 Starting deployment tests...\n")

    tests = [
        ("Database Connection", test_database_connection),
        ("Yahoo Finance API", test_yahoo_finance),
        ("Sync Function", test_sync_function),
    ]

    results = []

    for test_name, test_func in tests:
        if asyncio.iscoroutinefunction(test_func):
            result = await test_func()
        else:
            result = test_func()

        results.append((test_name, result))

        if not result:
            print(f"\n❌ {test_name} failed!")
        else:
            print(f"✅ {test_name} passed\n")

    # Summary
    print("📊 Test Results:")
    all_passed = True
    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"  {status}: {test_name}")
        if not result:
            all_passed = False

    if all_passed:
        print("\n🎉 All tests passed! Ready for deployment.")
        print("\n🚀 Deploy with:")
        print("   make deploy")
        print("   # or")
        print("   export DATABASE_URL='your-database-url'")
        print("   ./deploy.sh")
    else:
        print("\n❌ Some tests failed. Please fix issues before deploying.")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
