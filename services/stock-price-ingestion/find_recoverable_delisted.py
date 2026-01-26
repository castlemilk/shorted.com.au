#!/usr/bin/env python3
"""
Find delisted stocks that might still have recoverable historical data
"""

import asyncio
import asyncpg
import os
import sys
from datetime import datetime, timedelta

DATABASE_URL = os.getenv('DATABASE_URL')
if not DATABASE_URL:
    print("❌ ERROR: DATABASE_URL environment variable not set")
    sys.exit(1)

async def find_recoverable():
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        # Find stocks that:
        # 1. Have significant shorts history
        # 2. Were active relatively recently (last 2-3 years)
        # 3. Don't have price data yet
        query = """
            WITH stock_activity AS (
                SELECT 
                    "PRODUCT_CODE" as code,
                    "PRODUCT" as name,
                    MIN("DATE") as first_date,
                    MAX("DATE") as last_date,
                    COUNT(*) as entries,
                    AVG("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") as avg_short_pct
                FROM shorts
                WHERE "PRODUCT_CODE" IS NOT NULL
                GROUP BY "PRODUCT_CODE", "PRODUCT"
                HAVING COUNT(*) > 100  -- Meaningful history
                AND MAX("DATE") > '2022-01-01'  -- Active in last 3 years
                AND MAX("DATE") < CURRENT_DATE - INTERVAL '3 months'  -- But not currently active
            ),
            price_coverage AS (
                SELECT 
                    REPLACE(stock_code, '.AX', '') as code,
                    COUNT(*) as price_records
                FROM stock_prices
                GROUP BY stock_code
            )
            SELECT 
                sa.code,
                sa.name,
                sa.first_date,
                sa.last_date,
                sa.entries,
                sa.avg_short_pct,
                COALESCE(pc.price_records, 0) as price_records,
                (sa.last_date - sa.first_date) as trading_days
            FROM stock_activity sa
            LEFT JOIN price_coverage pc ON sa.code = pc.code
            WHERE pc.price_records IS NULL OR pc.price_records < 50
            ORDER BY sa.last_date DESC, sa.entries DESC
            LIMIT 50
        """
        
        rows = await conn.fetch(query)
        
        print("🔍 Potentially Recoverable Delisted Stocks")
        print("="*80)
        print(f"{'Code':<10} {'Name':<30} {'Last Active':<12} {'Days':<8} {'Shorts':<8} {'Prices'}")
        print("-"*80)
        
        for row in rows:
            trading_days = row['trading_days'].days if row['trading_days'] else 0
            print(f"{row['code']:<10} {row['name'][:30]:<30} {row['last_date'].strftime('%Y-%m-%d'):<12} "
                  f"{trading_days:<8} {row['entries']:<8} {row['price_records']}")
        
        print("\n📊 Summary:")
        print(f"Found {len(rows)} stocks that were active 2022-2024 but may be delisted")
        print("\nThese stocks had significant trading history and might have recoverable data.")
        print("Some may be:")
        print("  • Recently delisted/acquired companies")
        print("  • Companies that changed ticker symbols")  
        print("  • Suspended but not yet delisted")
        print("  • ETFs or other instruments with different data sources")
        
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(find_recoverable())