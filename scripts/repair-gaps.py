#!/usr/bin/env python3
"""
Repair historical data gaps for ASX stocks.

This script detects and fills gaps in historical stock price data.
It can be run on specific stocks or as a batch operation on all stocks
that need repair.

Usage:
    # Repair specific stocks
    python repair-gaps.py --stocks CBA,BHP,CSL
    
    # Repair all stocks with insufficient data (< 2000 records)
    python repair-gaps.py --repair-all
    
    # Repair top 50 stocks by market cap
    python repair-gaps.py --limit 50
    
    # Dry run (show what would be repaired)
    python repair-gaps.py --repair-all --dry-run
"""
import asyncio
import os
import sys
import logging
import argparse
from datetime import date, timedelta
from typing import List, Tuple

# Add services/market-data to path
sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "services/market-data"))

try:
    import asyncpg
    from enhanced_historical_processor import EnhancedStockDataProcessor
except ImportError as e:
    print(f"❌ Error: Could not import required modules: {e}")
    print("   Make sure you are running from the project root and have installed dependencies.")
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Minimum records for a stock to be considered "complete" (~10 years of data)
MIN_COMPLETE_RECORDS = 2000

# Rate limiting for Yahoo Finance (avoid getting blocked)
YAHOO_DELAY_SECONDS = 1.0


async def get_stocks_needing_repair(conn: asyncpg.Connection, min_records: int = MIN_COMPLETE_RECORDS) -> List[Tuple[str, int, date, date]]:
    """
    Get list of stocks that need historical data repair.
    
    Returns list of (stock_code, record_count, earliest_date, latest_date) tuples.
    """
    rows = await conn.fetch(
        """
        SELECT 
            stock_code, 
            COUNT(*) as records,
            MIN(date) as earliest,
            MAX(date) as latest
        FROM stock_prices 
        GROUP BY stock_code
        HAVING COUNT(*) < $1
        ORDER BY COUNT(*) ASC
        """,
        min_records
    )
    return [(row["stock_code"], row["records"], row["earliest"], row["latest"]) for row in rows]


async def get_all_shorted_stocks(conn: asyncpg.Connection) -> List[str]:
    """Get all stocks that have short selling data (priority stocks)."""
    rows = await conn.fetch(
        """
        SELECT DISTINCT stock_code 
        FROM short_positions 
        WHERE stock_code NOT LIKE '%.AX'
        ORDER BY stock_code
        """
    )
    return [row["stock_code"] for row in rows]


async def repair_stock(
    processor: EnhancedStockDataProcessor, 
    conn: asyncpg.Connection, 
    stock_code: str, 
    years: int = 10
) -> Tuple[bool, int]:
    """
    Repair a single stock's historical data.
    
    Returns (success, records_inserted) tuple.
    """
    try:
        records = await processor.update_stock_in_database(conn, stock_code, years=years)
        return (True, records)
    except Exception as e:
        logger.error(f"❌ Failed to repair {stock_code}: {e}")
        return (False, 0)


async def main():
    parser = argparse.ArgumentParser(
        description="Repair historical data gaps for ASX stocks",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument("--stocks", help="Comma-separated list of stock codes (e.g. CBA,BHP)")
    parser.add_argument("--repair-all", action="store_true", help="Repair all stocks with insufficient data")
    parser.add_argument("--limit", type=int, help="Limit to N stocks (processed in order of fewest records first)")
    parser.add_argument("--years", type=int, default=10, help="Number of years of historical data to fetch (default: 10)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be repaired without making changes")
    parser.add_argument("--min-records", type=int, default=MIN_COMPLETE_RECORDS, 
                        help=f"Minimum records to consider stock complete (default: {MIN_COMPLETE_RECORDS})")
    
    args = parser.parse_args()
    
    DATABASE_URL = os.getenv("DATABASE_URL")
    if not DATABASE_URL:
        logger.error("❌ DATABASE_URL environment variable is required")
        return
        
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        # Determine which stocks to repair
        if args.stocks:
            stock_list = [s.strip().upper() for s in args.stocks.split(",")]
            logger.info(f"🛠️ Starting gap repair for specific stocks: {', '.join(stock_list)}")
        elif args.repair_all:
            stocks_needing_repair = await get_stocks_needing_repair(conn, min_records=args.min_records)
            if args.limit:
                stocks_needing_repair = stocks_needing_repair[:args.limit]
            stock_list = [s[0] for s in stocks_needing_repair]
            
            if not stock_list:
                logger.info(f"✅ All stocks have at least {args.min_records} records - nothing to repair!")
                return
                
            logger.info(f"🛠️ Found {len(stock_list)} stocks needing repair (< {args.min_records} records)")
            
            # Show summary
            for stock_code, records, earliest, latest in stocks_needing_repair[:10]:
                logger.info(f"   {stock_code}: {records} records ({earliest} to {latest})")
            if len(stocks_needing_repair) > 10:
                logger.info(f"   ... and {len(stocks_needing_repair) - 10} more")
        else:
            # Default: repair stocks from short positions data
            logger.info(f"🛠️ Starting gap repair for top {args.limit or 'all'} stocks by short interest")
            stock_list = await get_all_shorted_stocks(conn)
            if args.limit:
                stock_list = stock_list[:args.limit]
        
        if args.dry_run:
            logger.info(f"🔍 DRY RUN - Would repair {len(stock_list)} stocks:")
            for stock in stock_list:
                logger.info(f"   - {stock}")
            return
        
        # Process stocks
        processor = EnhancedStockDataProcessor()
        
        total = len(stock_list)
        success_count = 0
        fail_count = 0
        total_records = 0
        
        for i, stock_code in enumerate(stock_list, 1):
            logger.info(f"[{i}/{total}] Repairing {stock_code}...")
            
            success, records = await repair_stock(processor, conn, stock_code, years=args.years)
            
            if success:
                success_count += 1
                total_records += records
            else:
                fail_count += 1
            
            # Rate limiting to avoid API throttling
            if i < total:
                await asyncio.sleep(YAHOO_DELAY_SECONDS)
        
        # Summary
        logger.info("")
        logger.info("=" * 60)
        logger.info(f"📊 REPAIR SUMMARY")
        logger.info("=" * 60)
        logger.info(f"   Total stocks processed: {total}")
        logger.info(f"   Successful: {success_count}")
        logger.info(f"   Failed: {fail_count}")
        logger.info(f"   Total records inserted/updated: {total_records:,}")
        logger.info("=" * 60)
        
    finally:
        await conn.close()


if __name__ == "__main__":
    if not os.getenv("DATABASE_URL"):
        print("❌ Error: DATABASE_URL environment variable is not set.")
        sys.exit(1)
    asyncio.run(main())
