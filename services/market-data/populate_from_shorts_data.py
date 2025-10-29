#!/usr/bin/env python3
"""
Populate historical price data for ALL stocks found in the shorts table.
This ensures every stock with short data also has price data available.
"""
import asyncio
import asyncpg
from datetime import date, timedelta
import yfinance as yf
import pandas as pd
import time
import os
from typing import List, Dict, Set

# Database configuration
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")


async def get_all_stocks_from_shorts() -> Set[str]:
    """Get all unique stock codes from the shorts table."""
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        stocks = await conn.fetch(
            'SELECT DISTINCT "PRODUCT_CODE" FROM shorts ORDER BY "PRODUCT_CODE"'
        )
        stock_codes = {row["PRODUCT_CODE"] for row in stocks}
        print(f"📊 Found {len(stock_codes)} unique stocks in shorts table")
        return stock_codes
    finally:
        await conn.close()


async def check_existing_data(conn, stock_code: str) -> bool:
    """Check if stock already has substantial historical data."""
    existing = await conn.fetchrow(
        """
        SELECT COUNT(*) as count, MIN(date) as earliest, MAX(date) as latest
        FROM stock_prices WHERE stock_code = $1
        """,
        stock_code,
    )
    
    # Skip if we already have more than 1000 records (likely already has years of data)
    if existing["count"] and existing["count"] > 1000:
        years = (
            (existing["latest"] - existing["earliest"]).days / 365.25
            if existing["earliest"]
            else 0
        )
        print(
            f"  ⏭️  Skipping {stock_code} - already has {existing['count']:,} records ({years:.1f} years)"
        )
        return True
    return False


def fetch_stock_price_data(stock_code: str, years: int = 10) -> List[Dict]:
    """Fetch historical price data from Yahoo Finance."""
    # Try with .AX suffix for ASX stocks
    yf_ticker = f"{stock_code}.AX"
    
    try:
        print(f"  📈 Fetching {years} years of data for {stock_code}...")
        
        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=years * 365)
        
        hist = ticker.history(start=start_date, end=end_date, interval="1d")
        
        if hist.empty:
            print(f"    ⚠️  No data available for {yf_ticker}")
            return []
        
        # Convert to our format
        data = []
        for date_idx, row in hist.iterrows():
            if pd.isna(row["Open"]) or pd.isna(row["Close"]):
                continue
            
            data.append(
                {
                    "stock_code": stock_code,
                    "date": date_idx.date(),
                    "open": round(float(row["Open"]), 2),
                    "high": round(float(row["High"]), 2),
                    "low": round(float(row["Low"]), 2),
                    "close": round(float(row["Close"]), 2),
                    "adjusted_close": round(float(row["Close"]), 2),
                    "volume": int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
                }
            )
        
        print(f"    ✅ Fetched {len(data)} records")
        return data
        
    except Exception as e:
        print(f"    ❌ Error fetching {stock_code}: {e}")
        return []


async def insert_price_data(conn, data: List[Dict]) -> int:
    """Insert price data into the database."""
    if not data:
        return 0
    
    inserted = 0
    batch_size = 100
    
    for i in range(0, len(data), batch_size):
        batch = data[i : i + batch_size]
        
        try:
            await conn.executemany(
                """
                INSERT INTO stock_prices 
                (stock_code, date, open, high, low, close, adjusted_close, volume)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (stock_code, date) DO UPDATE SET
                    open = EXCLUDED.open,
                    high = EXCLUDED.high,
                    low = EXCLUDED.low,
                    close = EXCLUDED.close,
                    adjusted_close = EXCLUDED.adjusted_close,
                    volume = EXCLUDED.volume,
                    updated_at = CURRENT_TIMESTAMP
                """,
                [
                    (
                        d["stock_code"],
                        d["date"],
                        d["open"],
                        d["high"],
                        d["low"],
                        d["close"],
                        d["adjusted_close"],
                        d["volume"],
                    )
                    for d in batch
                ],
            )
            inserted += len(batch)
        except Exception as e:
            print(f"    ❌ Error inserting batch: {e}")
    
    return inserted


async def populate_stock(conn, stock_code: str) -> tuple[int, str]:
    """Populate historical data for a single stock."""
    # Check if already populated
    if await check_existing_data(conn, stock_code):
        return 0, "skipped"
    
    # Fetch data
    data = fetch_stock_price_data(stock_code, years=10)
    
    if not data:
        return 0, "no_data"
    
    # Insert data
    inserted = await insert_price_data(conn, data)
    
    if inserted > 0:
        print(f"    ✅ Inserted {inserted} records")
        return inserted, "success"
    else:
        return 0, "failed"


async def main():
    """Main function to populate all stocks from shorts table."""
    print("🚀 Populating historical price data for ALL stocks with short positions\n")
    
    # Get all stocks from shorts table
    all_stocks = await get_all_stocks_from_shorts()
    
    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        total_inserted = 0
        successful = 0
        skipped = 0
        no_data = 0
        failed = 0
        
        for i, stock_code in enumerate(sorted(all_stocks), 1):
            print(f"\n[{i:4d}/{len(all_stocks)}] Processing {stock_code}")
            
            try:
                inserted, status = await populate_stock(conn, stock_code)
                
                if status == "success":
                    total_inserted += inserted
                    successful += 1
                elif status == "skipped":
                    skipped += 1
                elif status == "no_data":
                    no_data += 1
                else:
                    failed += 1
                
            except Exception as e:
                print(f"    ❌ Failed: {e}")
                failed += 1
            
            # Rate limiting - be nice to Yahoo Finance
            time.sleep(0.5)
        
        # Print summary
        print("\n" + "=" * 60)
        print("📊 POPULATION COMPLETE")
        print("=" * 60)
        print(f"✅ Successful: {successful}")
        print(f"⏭️  Skipped (already populated): {skipped}")
        print(f"⚠️  No data available: {no_data}")
        print(f"❌ Failed: {failed}")
        print(f"➕ Total records inserted: {total_inserted:,}")
        print("=" * 60)
        
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())

