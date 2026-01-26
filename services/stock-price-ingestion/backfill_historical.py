#!/usr/bin/env python3
"""
Backfill historical stock price data for all ASX stocks.
Fetches all stock codes from shorts table and populates historical prices.
"""

import asyncio
import asyncpg
import yfinance as yf
from datetime import datetime, date, timedelta
import logging
from typing import List, Optional
import time
import os
import sys
from tqdm import tqdm
from tqdm.asyncio import tqdm as atqdm

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

class StockBackfill:
    def __init__(self):
        self.pool = None
        self.total_inserted = 0
        self.total_updated = 0
        self.failed_stocks = []
        
    async def init_pool(self):
        """Initialize database connection pool"""
        self.pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
        
    async def close_pool(self):
        """Close database connection pool"""
        if self.pool:
            await self.pool.close()
    
    async def get_stock_codes(self, limit: Optional[int] = None) -> List[str]:
        """Get all unique stock codes from shorts table"""
        async with self.pool.acquire() as conn:
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
            codes = [row['code'] for row in rows]
            logger.info(f"Found {len(codes)} unique stock codes")
            return codes
    
    async def check_existing_data(self, stock_code: str) -> tuple:
        """Check if we already have data for this stock"""
        async with self.pool.acquire() as conn:
            result = await conn.fetchrow("""
                SELECT 
                    COUNT(*) as count,
                    MIN(date) as min_date,
                    MAX(date) as max_date
                FROM stock_prices 
                WHERE stock_code = $1
            """, f"{stock_code}.AX")
            
            return result['count'], result['min_date'], result['max_date']
    
    def fetch_stock_data(self, stock_code: str, start_date: date, end_date: date) -> Optional[dict]:
        """Fetch historical data for a single stock using yfinance"""
        try:
            # Add .AX suffix for ASX stocks
            symbol = f"{stock_code}.AX" if not stock_code.endswith('.AX') else stock_code
            
            # Create ticker object
            ticker = yf.Ticker(symbol)
            
            # Fetch historical data
            df = ticker.history(start=start_date, end=end_date, interval='1d')
            
            if df.empty:
                return None
            
            # Prepare data for insertion
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
            
            return {'symbol': symbol, 'records': records}
            
        except Exception as e:
            logger.debug(f"Error fetching {stock_code}: {str(e)}")
            return None
    
    async def insert_stock_data(self, symbol: str, records: List[dict]) -> tuple:
        """Insert stock price data into database"""
        inserted = 0
        updated = 0
        
        async with self.pool.acquire() as conn:
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
                        inserted += 1
                    else:
                        updated += 1
                        
                except Exception as e:
                    logger.debug(f"Error inserting {symbol} {record['date']}: {e}")
        
        return inserted, updated
    
    async def process_stock(self, stock_code: str, start_date: date, end_date: date, skip_existing: bool = True):
        """Process a single stock"""
        try:
            # Check existing data
            if skip_existing:
                count, min_date, max_date = await self.check_existing_data(stock_code)
                if count > 100:  # If we have substantial data, skip
                    logger.debug(f"Skipping {stock_code} - already has {count} records")
                    return
            
            # Fetch data
            data = self.fetch_stock_data(stock_code, start_date, end_date)
            
            if not data:
                logger.debug(f"No data found for {stock_code}")
                self.failed_stocks.append(stock_code)
                return
            
            # Insert data
            inserted, updated = await self.insert_stock_data(data['symbol'], data['records'])
            self.total_inserted += inserted
            self.total_updated += updated
            
            if inserted > 0:
                logger.info(f"✓ {stock_code}: {inserted} records inserted, {updated} updated")
                
        except Exception as e:
            logger.error(f"Error processing {stock_code}: {e}")
            self.failed_stocks.append(stock_code)
    
    async def run_backfill(self, 
                          years_back: int = 2,
                          batch_size: int = 10,
                          delay_between_batches: float = 1.0,
                          limit: Optional[int] = None,
                          skip_existing: bool = True):
        """Run the backfill process"""
        
        await self.init_pool()
        
        try:
            # Get stock codes
            stock_codes = await self.get_stock_codes(limit)
            
            # Calculate date range
            end_date = datetime.now().date()
            start_date = end_date - timedelta(days=years_back * 365)
            
            print(f"\n🚀 Starting backfill for {len(stock_codes)} stocks")
            print(f"📅 Date range: {start_date} to {end_date}")
            print(f"⚙️  Batch size: {batch_size}, Delay: {delay_between_batches}s\n")
            
            # Create progress bars
            total_pbar = tqdm(
                total=len(stock_codes),
                desc="Overall Progress",
                unit="stocks",
                colour="green",
                position=0,
                leave=True
            )
            
            stats_pbar = tqdm(
                total=0,
                desc="Records",
                unit="rec",
                colour="blue",
                position=1,
                leave=True,
                bar_format="{desc}: Inserted={n} Updated={r_bar}"
            )
            
            # Process in batches
            for i in range(0, len(stock_codes), batch_size):
                batch = stock_codes[i:i + batch_size]
                batch_num = (i // batch_size) + 1
                total_batches = (len(stock_codes) + batch_size - 1) // batch_size
                
                # Create batch progress bar
                batch_pbar = tqdm(
                    total=len(batch),
                    desc=f"Batch {batch_num}/{total_batches}",
                    unit="stock",
                    colour="yellow",
                    position=2,
                    leave=False
                )
                
                # Process batch concurrently
                tasks = []
                for stock_code in batch:
                    tasks.append(self.process_stock_with_progress(
                        stock_code, start_date, end_date, skip_existing, batch_pbar, stats_pbar
                    ))
                
                await asyncio.gather(*tasks)
                
                # Update overall progress
                total_pbar.update(len(batch))
                batch_pbar.close()
                
                # Delay between batches to avoid rate limiting
                if i + batch_size < len(stock_codes):
                    await asyncio.sleep(delay_between_batches)
            
            total_pbar.close()
            stats_pbar.close()
            
            print("\n" + "="*60)
            print("✅ BACKFILL COMPLETE!")
            print("="*60)
            print(f"📊 Total records inserted: {self.total_inserted:,}")
            print(f"📝 Total records updated: {self.total_updated:,}")
            print(f"❌ Failed stocks: {len(self.failed_stocks)}")
            
            if self.failed_stocks and len(self.failed_stocks) < 50:
                print(f"Failed stocks: {', '.join(self.failed_stocks[:50])}")
            
        finally:
            await self.close_pool()
    
    async def process_stock_with_progress(self, stock_code: str, start_date: date, end_date: date, 
                                         skip_existing: bool, batch_pbar: tqdm, stats_pbar: tqdm):
        """Process a single stock with progress bar updates"""
        try:
            # Check existing data
            if skip_existing:
                count, min_date, max_date = await self.check_existing_data(stock_code)
                if count > 100:  # If we have substantial data, skip
                    batch_pbar.update(1)
                    batch_pbar.set_postfix_str(f"Skipped {stock_code}")
                    return
            
            # Fetch data
            batch_pbar.set_postfix_str(f"Fetching {stock_code}")
            data = self.fetch_stock_data(stock_code, start_date, end_date)
            
            if not data:
                self.failed_stocks.append(stock_code)
                batch_pbar.update(1)
                batch_pbar.set_postfix_str(f"No data for {stock_code}")
                return
            
            # Insert data
            batch_pbar.set_postfix_str(f"Inserting {stock_code}")
            inserted, updated = await self.insert_stock_data(data['symbol'], data['records'])
            self.total_inserted += inserted
            self.total_updated += updated
            
            # Update progress bars
            batch_pbar.update(1)
            batch_pbar.set_postfix_str(f"✓ {stock_code}: {inserted} records")
            stats_pbar.n = self.total_inserted
            stats_pbar.set_postfix_str(f"Updated={self.total_updated}")
            stats_pbar.refresh()
                
        except Exception as e:
            logger.error(f"Error processing {stock_code}: {e}")
            self.failed_stocks.append(stock_code)
            batch_pbar.update(1)
            batch_pbar.set_postfix_str(f"Error: {stock_code}")

async def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Backfill historical stock price data')
    parser.add_argument('--years', type=int, default=2, help='Years of historical data to fetch (default: 2)')
    parser.add_argument('--batch-size', type=int, default=10, help='Number of stocks to process concurrently (default: 10)')
    parser.add_argument('--delay', type=float, default=1.0, help='Delay between batches in seconds (default: 1.0)')
    parser.add_argument('--limit', type=int, help='Limit number of stocks to process (for testing)')
    parser.add_argument('--force', action='store_true', help='Force re-fetch even if data exists')
    
    args = parser.parse_args()
    
    backfill = StockBackfill()
    await backfill.run_backfill(
        years_back=args.years,
        batch_size=args.batch_size,
        delay_between_batches=args.delay,
        limit=args.limit,
        skip_existing=not args.force
    )

if __name__ == "__main__":
    asyncio.run(main())