#!/usr/bin/env python3
"""
Backfill historical price data for delisted stocks.
Fetches data only for the period when they were active (based on shorts data).
"""

import asyncio
import asyncpg
import yfinance as yf
from datetime import datetime, date, timedelta
import logging
from typing import List, Optional, Dict, Tuple
import os
import sys
from tqdm import tqdm
import pandas as pd

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
    sys.exit(1)

class DelistedStockBackfill:
    def __init__(self):
        self.pool = None
        self.total_inserted = 0
        self.total_updated = 0
        self.stocks_processed = 0
        self.stocks_with_data = 0
        
    async def init_pool(self):
        """Initialize database connection pool"""
        self.pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
        
    async def close_pool(self):
        """Close database connection pool"""
        if self.pool:
            await self.pool.close()
    
    async def get_delisted_stocks(self) -> List[Dict]:
        """Get stocks that appear delisted (no current price data but have shorts history)"""
        async with self.pool.acquire() as conn:
            # Find stocks with shorts data but no price data
            # Also get their active date range from shorts table
            query = """
                WITH stock_dates AS (
                    SELECT 
                        "PRODUCT_CODE" as code,
                        MIN("DATE") as first_short_date,
                        MAX("DATE") as last_short_date,
                        COUNT(*) as short_entries
                    FROM shorts
                    WHERE "PRODUCT_CODE" IS NOT NULL
                    GROUP BY "PRODUCT_CODE"
                ),
                stocks_with_prices AS (
                    SELECT DISTINCT 
                        REPLACE(stock_code, '.AX', '') as code,
                        COUNT(*) as price_entries
                    FROM stock_prices
                    GROUP BY stock_code
                )
                SELECT 
                    sd.code,
                    sd.first_short_date,
                    sd.last_short_date,
                    sd.short_entries,
                    COALESCE(sp.price_entries, 0) as price_entries
                FROM stock_dates sd
                LEFT JOIN stocks_with_prices sp ON sd.code = sp.code
                WHERE 
                    -- No price data or very little
                    (sp.price_entries IS NULL OR sp.price_entries < 50)
                    -- Has meaningful shorts data
                    AND sd.short_entries > 10
                    -- Not too recent (likely delisted if no recent shorts)
                    AND sd.last_short_date < CURRENT_DATE - INTERVAL '6 months'
                ORDER BY sd.last_short_date DESC
            """
            
            rows = await conn.fetch(query)
            stocks = []
            for row in rows:
                stocks.append({
                    'code': row['code'],
                    'first_date': row['first_short_date'],
                    'last_date': row['last_short_date'],
                    'short_entries': row['short_entries'],
                    'price_entries': row['price_entries']
                })
            
            return stocks
    
    def fetch_historical_data(self, stock_code: str, start_date: date, end_date: date) -> Optional[Dict]:
        """Fetch historical data for a potentially delisted stock"""
        try:
            symbol = f"{stock_code}.AX" if not stock_code.endswith('.AX') else stock_code
            
            # Try to get historical data even if stock is delisted
            ticker = yf.Ticker(symbol)
            
            # Extend date range a bit to catch more data
            extended_start = start_date - timedelta(days=30)
            extended_end = end_date + timedelta(days=30)
            
            # Try different methods to get historical data
            df = None
            
            # Method 1: Standard history
            try:
                df = ticker.history(start=extended_start, end=extended_end, interval='1d')
            except:
                pass
            
            # Method 2: Download function (sometimes works better for delisted)
            if df is None or df.empty:
                try:
                    df = yf.download(symbol, start=extended_start, end=extended_end, progress=False)
                except:
                    pass
            
            if df is not None and not df.empty:
                records = []
                for idx, row in df.iterrows():
                    # Only include dates within our target range
                    row_date = idx.date() if hasattr(idx, 'date') else idx
                    if start_date <= row_date <= end_date:
                        records.append({
                            'date': row_date,
                            'open': float(row['Open']) if pd.notna(row['Open']) else None,
                            'high': float(row['High']) if pd.notna(row['High']) else None,
                            'low': float(row['Low']) if pd.notna(row['Low']) else None,
                            'close': float(row['Close']) if pd.notna(row['Close']) else None,
                            'volume': int(row['Volume']) if pd.notna(row['Volume']) else None
                        })
                
                if records:
                    return {'symbol': symbol, 'records': records}
            
            return None
            
        except Exception as e:
            logger.debug(f"Could not fetch {stock_code}: {str(e)}")
            return None
    
    async def insert_historical_data(self, symbol: str, records: List[dict]) -> Tuple[int, int]:
        """Insert historical stock data"""
        inserted = 0
        updated = 0
        
        async with self.pool.acquire() as conn:
            for record in records:
                try:
                    # Skip if all price fields are None
                    if all(record[field] is None for field in ['open', 'high', 'low', 'close']):
                        continue
                        
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
    
    async def process_delisted_stock(self, stock_info: Dict):
        """Process a single delisted stock"""
        code = stock_info['code']
        start_date = stock_info['first_date']
        last_date = stock_info['last_date']
        
        # Fetch historical data for the active period
        data = self.fetch_historical_data(code, start_date, last_date)
        
        if data and data['records']:
            inserted, updated = await self.insert_historical_data(data['symbol'], data['records'])
            self.total_inserted += inserted
            self.total_updated += updated
            
            if inserted > 0:
                self.stocks_with_data += 1
                logger.info(f"✓ {code}: {inserted} records ({start_date} to {last_date})")
                return True
        
        return False
    
    async def run_backfill(self, limit: Optional[int] = None):
        """Run the delisted stock backfill process"""
        
        await self.init_pool()
        
        try:
            # Get delisted stocks
            print("🔍 Finding delisted stocks with shorts history...")
            delisted_stocks = await self.get_delisted_stocks()
            
            if limit:
                delisted_stocks = delisted_stocks[:limit]
            
            print(f"📊 Found {len(delisted_stocks)} potentially delisted stocks to process")
            
            if not delisted_stocks:
                print("No delisted stocks to process")
                return
            
            # Show some examples
            print("\n📋 Sample stocks to process:")
            for stock in delisted_stocks[:5]:
                print(f"  {stock['code']}: {stock['first_date']} to {stock['last_date']} ({stock['short_entries']} shorts entries)")
            
            print(f"\n🚀 Starting historical backfill for delisted stocks...")
            
            # Progress bar
            pbar = tqdm(
                total=len(delisted_stocks),
                desc="Processing delisted stocks",
                unit="stocks",
                colour="yellow"
            )
            
            # Process in batches to avoid overwhelming the API
            batch_size = 10
            for i in range(0, len(delisted_stocks), batch_size):
                batch = delisted_stocks[i:i + batch_size]
                
                # Process batch
                tasks = []
                for stock_info in batch:
                    tasks.append(self.process_delisted_stock(stock_info))
                
                results = await asyncio.gather(*tasks)
                self.stocks_processed += len(batch)
                
                # Update progress
                pbar.update(len(batch))
                pbar.set_postfix({
                    'with_data': self.stocks_with_data,
                    'inserted': self.total_inserted
                })
                
                # Small delay between batches
                await asyncio.sleep(1)
            
            pbar.close()
            
            print("\n" + "="*60)
            print("✅ DELISTED STOCK BACKFILL COMPLETE!")
            print("="*60)
            print(f"📊 Stocks processed: {self.stocks_processed}")
            print(f"📈 Stocks with data found: {self.stocks_with_data}")
            print(f"📝 Total records inserted: {self.total_inserted:,}")
            print(f"🔄 Total records updated: {self.total_updated:,}")
            
            if self.stocks_with_data > 0:
                success_rate = (self.stocks_with_data / self.stocks_processed) * 100
                print(f"✨ Success rate: {success_rate:.1f}%")
            
        finally:
            await self.close_pool()

async def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Backfill historical data for delisted stocks')
    parser.add_argument('--limit', type=int, help='Limit number of stocks to process')
    
    args = parser.parse_args()
    
    backfill = DelistedStockBackfill()
    await backfill.run_backfill(limit=args.limit)

if __name__ == "__main__":
    asyncio.run(main())