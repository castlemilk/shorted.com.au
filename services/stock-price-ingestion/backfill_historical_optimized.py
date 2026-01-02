#!/usr/bin/env python3
"""
Optimized backfill script that handles delisted stocks more efficiently.
Maintains a cache of failed stocks to skip them on subsequent runs.
"""

import asyncio
import asyncpg
import yfinance as yf
from datetime import datetime, date, timedelta
import logging
from typing import List, Optional, Set
import time
import os
import sys
import json
import pickle
from pathlib import Path
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor
import signal

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Get database URL from environment variable
DATABASE_URL = os.getenv('DATABASE_URL')
if not DATABASE_URL:
    print("❌ ERROR: DATABASE_URL environment variable not set")
    print("Please set it using: export DATABASE_URL='your-database-url'")
    sys.exit(1)

class OptimizedStockBackfill:
    def __init__(self):
        self.pool = None
        self.total_inserted = 0
        self.total_updated = 0
        self.failed_stocks = set()
        self.delisted_stocks = set()
        self.cache_file = Path("stock_backfill_cache.pkl")
        self.executor = ThreadPoolExecutor(max_workers=5)
        self.interrupted = False
        
        # Load cache
        self.load_cache()
        
        # Set up signal handler for graceful shutdown
        signal.signal(signal.SIGINT, self.signal_handler)
        
    def signal_handler(self, sig, frame):
        """Handle Ctrl+C gracefully"""
        print("\n\n⚠️  Interrupt received! Saving progress...")
        self.interrupted = True
        self.save_cache()
        
    def load_cache(self):
        """Load cached data about failed/delisted stocks"""
        if self.cache_file.exists():
            try:
                with open(self.cache_file, 'rb') as f:
                    cache = pickle.load(f)
                    self.delisted_stocks = cache.get('delisted', set())
                    self.failed_stocks = cache.get('failed', set())
                    print(f"📂 Loaded cache: {len(self.delisted_stocks)} delisted, {len(self.failed_stocks)} failed stocks")
            except Exception as e:
                logger.warning(f"Could not load cache: {e}")
                
    def save_cache(self):
        """Save cache of failed/delisted stocks"""
        try:
            cache = {
                'delisted': self.delisted_stocks,
                'failed': self.failed_stocks,
                'updated': datetime.now().isoformat()
            }
            with open(self.cache_file, 'wb') as f:
                pickle.dump(cache, f)
            print(f"💾 Saved cache: {len(self.delisted_stocks)} delisted, {len(self.failed_stocks)} failed stocks")
        except Exception as e:
            logger.error(f"Could not save cache: {e}")
            
    async def init_pool(self):
        """Initialize database connection pool"""
        self.pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
        
    async def close_pool(self):
        """Close database connection pool"""
        if self.pool:
            await self.pool.close()
    
    async def get_stock_codes(self, limit: Optional[int] = None) -> List[str]:
        """Get all unique stock codes from shorts table, excluding known delisted"""
        async with self.pool.acquire() as conn:
            # Get already processed stocks
            processed = await conn.fetch("""
                SELECT DISTINCT stock_code, COUNT(*) as count 
                FROM stock_prices 
                GROUP BY stock_code
                HAVING COUNT(*) > 100
            """)
            processed_codes = {row['stock_code'].replace('.AX', '') for row in processed}
            
            # Get all stock codes
            query = """
                SELECT DISTINCT "PRODUCT_CODE" as code 
                FROM shorts 
                WHERE "PRODUCT_CODE" IS NOT NULL 
                AND LENGTH("PRODUCT_CODE") > 0
                ORDER BY "PRODUCT_CODE"
            """
            if limit:
                query += f" LIMIT {limit}"
                
            rows = await conn.fetch(query)
            all_codes = [row['code'] for row in rows]
            
            # Filter out already processed and known delisted
            codes = []
            skipped = 0
            for code in all_codes:
                if code in self.delisted_stocks:
                    skipped += 1
                    continue
                if f"{code}.AX" in processed_codes or code in processed_codes:
                    skipped += 1
                    continue
                codes.append(code)
            
            print(f"📊 Found {len(all_codes)} total stocks")
            print(f"⏭️  Skipping {skipped} (already processed or delisted)")
            print(f"🎯 Will process {len(codes)} stocks")
            
            return codes
    
    def fetch_stock_data_batch(self, stock_codes: List[str], start_date: date, end_date: date) -> dict:
        """Fetch data for multiple stocks efficiently"""
        results = {}
        
        # Build symbol list
        symbols = []
        code_map = {}
        for code in stock_codes:
            if code not in self.delisted_stocks:
                symbol = f"{code}.AX" if not code.endswith('.AX') else code
                symbols.append(symbol)
                code_map[symbol] = code
        
        if not symbols:
            return results
        
        # Try to fetch all at once (much faster than individual requests)
        try:
            # yfinance can download multiple tickers at once
            data = yf.download(
                symbols, 
                start=start_date, 
                end=end_date,
                group_by='ticker',
                auto_adjust=False,
                threads=True,
                progress=False
            )
            
            # Process results
            for symbol in symbols:
                try:
                    if len(symbols) == 1:
                        # Single ticker returns different structure
                        df = data
                    else:
                        # Multiple tickers
                        df = data[symbol] if symbol in data.columns.levels[0] else None
                    
                    if df is not None and not df.empty and not df['Close'].isna().all():
                        records = []
                        for idx, row in df.iterrows():
                            if not pd.isna(row['Close']):
                                records.append({
                                    'date': idx.date(),
                                    'open': float(row['Open']) if not pd.isna(row['Open']) else None,
                                    'high': float(row['High']) if not pd.isna(row['High']) else None,
                                    'low': float(row['Low']) if not pd.isna(row['Low']) else None,
                                    'close': float(row['Close']) if not pd.isna(row['Close']) else None,
                                    'volume': int(row['Volume']) if not pd.isna(row['Volume']) else None
                                })
                        
                        if records:
                            results[symbol] = records
                    else:
                        # Mark as delisted
                        self.delisted_stocks.add(code_map[symbol])
                        
                except Exception as e:
                    logger.debug(f"Error processing {symbol}: {e}")
                    self.failed_stocks.add(code_map[symbol])
                    
        except Exception as e:
            logger.error(f"Batch download failed: {e}")
            # Fall back to individual fetching
            for symbol in symbols:
                code = code_map[symbol]
                if code not in self.delisted_stocks:
                    try:
                        ticker = yf.Ticker(symbol)
                        df = ticker.history(start=start_date, end=end_date, interval='1d')
                        if not df.empty:
                            records = []
                            for idx, row in df.iterrows():
                                records.append({
                                    'date': idx.date(),
                                    'open': float(row['Open']) if row['Open'] else None,
                                    'high': float(row['High']) if row['High'] else None,
                                    'low': float(row['Low']) if row['Low'] else None,
                                    'close': float(row['Close']) if row['Close'] else None,
                                    'volume': int(row['Volume']) if row['Volume'] else None
                                })
                            results[symbol] = records
                        else:
                            self.delisted_stocks.add(code)
                    except Exception as e:
                        if "no timezone found" in str(e).lower() or "delisted" in str(e).lower():
                            self.delisted_stocks.add(code)
                        else:
                            self.failed_stocks.add(code)
        
        return results
    
    async def insert_batch_data(self, batch_data: dict) -> tuple:
        """Insert batch of stock data efficiently"""
        total_inserted = 0
        total_updated = 0
        
        async with self.pool.acquire() as conn:
            for symbol, records in batch_data.items():
                for record in records:
                    try:
                        result = await conn.execute("""
                            INSERT INTO stock_prices 
                            (stock_code, date, open, high, low, close, volume)
                            VALUES ($1, $2, $3, $4, $5, $6, $7)
                            ON CONFLICT (stock_code, date) DO UPDATE SET
                                open = EXCLUDED.open,
                                high = EXCLUDED.high,
                                low = EXCLUDED.low,
                                close = EXCLUDED.close,
                                volume = EXCLUDED.volume,
                                updated_at = CURRENT_TIMESTAMP
                        """,
                        symbol,
                        record['date'],
                        record['open'],
                        record['high'],
                        record['low'],
                        record['close'],
                        record['volume']
                        )
                        
                        if 'INSERT' in result:
                            total_inserted += 1
                        else:
                            total_updated += 1
                            
                    except Exception as e:
                        logger.debug(f"Error inserting {symbol} {record['date']}: {e}")
        
        return total_inserted, total_updated
    
    async def run_backfill(self, 
                          years_back: int = 2,
                          batch_size: int = 50,  # Larger batch size
                          limit: Optional[int] = None):
        """Run the optimized backfill process"""
        
        await self.init_pool()
        
        try:
            # Import pandas here (after checking other imports)
            global pd
            import pandas as pd
            
            # Get stock codes (already filtered)
            stock_codes = await self.get_stock_codes(limit)
            
            if not stock_codes:
                print("✅ All stocks already processed!")
                return
            
            # Calculate date range
            end_date = datetime.now().date()
            start_date = end_date - timedelta(days=years_back * 365)
            
            print(f"\n🚀 Starting optimized backfill for {len(stock_codes)} stocks")
            print(f"📅 Date range: {start_date} to {end_date}")
            print(f"⚙️  Batch size: {batch_size}\n")
            
            # Progress bar
            pbar = tqdm(total=len(stock_codes), desc="Overall Progress", unit="stocks", colour="green")
            
            # Process in batches
            for i in range(0, len(stock_codes), batch_size):
                if self.interrupted:
                    print("\n⛔ Backfill interrupted by user")
                    break
                    
                batch = stock_codes[i:i + batch_size]
                
                # Fetch batch data
                pbar.set_postfix_str(f"Fetching batch of {len(batch)} stocks...")
                batch_data = self.fetch_stock_data_batch(batch, start_date, end_date)
                
                # Insert batch data
                if batch_data:
                    pbar.set_postfix_str(f"Inserting {len(batch_data)} stocks...")
                    inserted, updated = await self.insert_batch_data(batch_data)
                    self.total_inserted += inserted
                    self.total_updated += updated
                    
                    pbar.set_postfix_str(f"Inserted: {self.total_inserted}, Delisted: {len(self.delisted_stocks)}")
                
                pbar.update(len(batch))
                
                # Save cache periodically
                if i % (batch_size * 10) == 0:
                    self.save_cache()
            
            pbar.close()
            
            # Save final cache
            self.save_cache()
            
            print("\n" + "="*60)
            print("✅ BACKFILL COMPLETE!")
            print("="*60)
            print(f"📊 Total records inserted: {self.total_inserted:,}")
            print(f"📝 Total records updated: {self.total_updated:,}")
            print(f"🚫 Delisted stocks found: {len(self.delisted_stocks)}")
            print(f"❌ Failed stocks: {len(self.failed_stocks)}")
            
            if len(self.delisted_stocks) > 0 and len(self.delisted_stocks) < 50:
                print(f"\nDelisted: {', '.join(list(self.delisted_stocks)[:50])}")
            
        finally:
            await self.close_pool()
            self.executor.shutdown()

async def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Optimized stock price backfill')
    parser.add_argument('--years', type=int, default=2, help='Years of historical data (default: 2)')
    parser.add_argument('--batch-size', type=int, default=50, help='Batch size (default: 50)')
    parser.add_argument('--limit', type=int, help='Limit number of stocks (for testing)')
    parser.add_argument('--clear-cache', action='store_true', help='Clear the delisted stocks cache')
    
    args = parser.parse_args()
    
    backfill = OptimizedStockBackfill()
    
    if args.clear_cache:
        print("🗑️  Clearing cache...")
        backfill.delisted_stocks.clear()
        backfill.failed_stocks.clear()
        backfill.save_cache()
        
    await backfill.run_backfill(
        years_back=args.years,
        batch_size=args.batch_size,
        limit=args.limit
    )

if __name__ == "__main__":
    asyncio.run(main())