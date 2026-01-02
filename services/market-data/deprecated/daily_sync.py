#!/usr/bin/env python3
"""Daily sync of ASX stock prices from Yahoo Finance"""

import asyncio
import asyncpg
import yfinance as yf
from datetime import date, timedelta
import os
import sys

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    print("❌ DATABASE_URL environment variable is required")
    sys.exit(1)

# ASX 200 stocks (subset - add more as needed)
ASX_STOCKS = [
    "CBA",
    "BHP",
    "CSL",
    "WBC",
    "ANZ",
    "NAB",
    "WES",
    "MQG",
    "WOW",
    "TLS",
    "RIO",
    "WDS",
    "GMG",
    "TCL",
    "COL",
    "FMG",
    "REA",
    "ALL",
    "IAG",
    "SUN",
    "QBE",
    "JHX",
    "AMC",
    "BXB",
    "NCM",
    "STO",
    "ORG",
    "XRO",
    "AGL",
    "RHC",
    "SHL",
    "COH",
    "RMD",
    "PME",
    "TWE",
    "QAN",
    "AZJ",
    "SEK",
    "CAR",
    "DHG",
]


async def sync_stock(conn, stock_code: str, days_back: int = 5):
    """Sync a single stock's recent data"""
    try:
        yf_ticker = f"{stock_code}.AX"
        print(f"📈 Syncing {stock_code}...")

        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=days_back)

        hist = ticker.history(start=start_date, end=end_date, interval="1d")

        if hist.empty:
            print(f"  ⚠️  No data for {stock_code}")
            return 0

        inserted = 0
        for date_idx, row in hist.iterrows():
            if row.isna().any():
                continue

            try:
                await conn.execute(
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
                    stock_code,
                    date_idx.date(),
                    round(float(row["Open"]), 2),
                    round(float(row["High"]), 2),
                    round(float(row["Low"]), 2),
                    round(float(row["Close"]), 2),
                    round(float(row["Close"]), 2),
                    int(row["Volume"]) if not row.isna()["Volume"] else 0,
                )
                inserted += 1
            except Exception as e:
                print(f"  ⚠️  Error inserting {date_idx.date()}: {e}")

        print(f"  ✅ {inserted} records")
        return inserted

    except Exception as e:
        print(f"  ❌ Error: {e}")
        return 0


async def main():
    """Main sync function"""
    print("🚀 Starting daily stock price sync")
    print(f"📊 Syncing {len(ASX_STOCKS)} stocks")

    conn = await asyncpg.connect(DATABASE_URL)

    try:
        total_inserted = 0

        for stock_code in ASX_STOCKS:
            inserted = await sync_stock(conn, stock_code, days_back=5)
            total_inserted += inserted

        print(f"\n🎉 Sync complete!")
        print(f"📈 Total records: {total_inserted}")

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
