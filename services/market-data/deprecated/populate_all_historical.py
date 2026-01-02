#!/usr/bin/env python3
"""
Populate all ASX stocks with 10 years of real historical data
"""
import asyncio
import asyncpg
from datetime import date, timedelta
import yfinance as yf
import pandas as pd
import time

import os

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")

# All ASX stocks we want to update with real 10-year data
ASX_STOCKS = {
    "CBA": "CBA.AX",  # Commonwealth Bank
    "BHP": "BHP.AX",  # BHP Billiton
    "CSL": "CSL.AX",  # CSL Limited
    "WBC": "WBC.AX",  # Westpac
    "ANZ": "ANZ.AX",  # ANZ Bank
    "NAB": "NAB.AX",  # National Australia Bank
    "WOW": "WOW.AX",  # Woolworths Group (already done)
    "COL": "COL.AX",  # Coles Group
    "WES": "WES.AX",  # Wesfarmers
    "RIO": "RIO.AX",  # Rio Tinto
    "TLS": "TLS.AX",  # Telstra
    "FMG": "FMG.AX",  # Fortescue Metals Group
    "NCM": "NCM.AX",  # Newcrest Mining
    "STO": "STO.AX",  # Santos
    "XRO": "XRO.AX",  # Xero Limited
}


def fetch_real_data(stock_code: str, yf_ticker: str, years: int = 10):
    """Fetch real historical data from yfinance"""
    print(f"  📈 Fetching {years} years of {stock_code} data...")

    try:
        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=years * 365)

        hist = ticker.history(start=start_date, end=end_date, interval="1d")

        if hist.empty:
            print(f"    ⚠️  No data available")
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

        print(f"    ✅ {len(data)} records ({data[0]['date']} to {data[-1]['date']})")
        return data

    except Exception as e:
        print(f"    ❌ Error: {e}")
        return []


async def update_stock(conn, stock_code: str, yf_ticker: str):
    """Update a single stock with real historical data"""

    # Check if stock already has substantial data (skip if already processed)
    existing = await conn.fetchrow(
        """
        SELECT COUNT(*) as count, MIN(date) as earliest, MAX(date) as latest
        FROM stock_prices WHERE stock_code = $1
    """,
        stock_code,
    )

    # Skip if we already have more than 2000 records (likely already has 10 years)
    if existing["count"] > 2000:
        years = (
            (existing["latest"] - existing["earliest"]).days / 365.25
            if existing["earliest"]
            else 0
        )
        print(
            f"  ⏭️  Skipping {stock_code} - already has {existing['count']:,} records ({years:.1f} years)"
        )
        return existing["count"]

    # Fetch real data
    data = fetch_real_data(stock_code, yf_ticker, 10)

    if not data:
        return 0

    # Delete existing data for clean replacement
    await conn.execute("DELETE FROM stock_prices WHERE stock_code = $1", stock_code)

    # Insert new data
    inserted = 0
    batch_size = 100

    for i in range(0, len(data), batch_size):
        batch = data[i : i + batch_size]

        for record in batch:
            try:
                await conn.execute(
                    """
                    INSERT INTO stock_prices 
                    (stock_code, date, open, high, low, close, adjusted_close, volume)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                """,
                    record["stock_code"],
                    record["date"],
                    record["open"],
                    record["high"],
                    record["low"],
                    record["close"],
                    record["adjusted_close"],
                    record["volume"],
                )
                inserted += 1
            except Exception as e:
                print(f"      ⚠️  Insert error for {record['date']}: {e}")
                continue

    print(f"    ✅ Inserted {inserted}/{len(data)} records")
    return inserted


async def populate_all_stocks():
    """Populate all stocks with 10 years of real data"""
    print(
        f"🚀 Populating {len(ASX_STOCKS)} ASX stocks with 10 years of real historical data"
    )
    print("📊 This will replace mock data with real market data from yfinance\n")

    conn = await asyncpg.connect(DATABASE_URL)

    try:
        total_inserted = 0
        successful_stocks = 0

        for i, (stock_code, yf_ticker) in enumerate(ASX_STOCKS.items(), 1):
            print(f"[{i:2d}/{len(ASX_STOCKS)}] {stock_code} ({yf_ticker})")

            inserted = await update_stock(conn, stock_code, yf_ticker)

            if inserted >= 0:
                total_inserted += inserted
                successful_stocks += 1

            # Rate limiting - be nice to Yahoo Finance
            time.sleep(2)
            print()

        # Final summary
        final_stats = await conn.fetch(
            """
            SELECT stock_code, COUNT(*) as records, MIN(date) as earliest, MAX(date) as latest
            FROM stock_prices 
            GROUP BY stock_code 
            ORDER BY stock_code
        """
        )

        total_records = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")
        overall_range = await conn.fetchrow(
            """
            SELECT MIN(date) as earliest, MAX(date) as latest FROM stock_prices
        """
        )

        print(f"🎉 Population completed!")
        print(f"📊 Total database records: {total_records:,}")
        print(
            f"📅 Overall date range: {overall_range['earliest']} to {overall_range['latest']}"
        )
        print(
            f"✅ Successfully processed: {successful_stocks}/{len(ASX_STOCKS)} stocks"
        )
        print(f"➕ Records inserted: {total_inserted:,}")

        print(f"\n📈 Final stock summary:")
        print("Stock | Records | Earliest   | Latest     | Years")
        print("------+---------+------------+------------+------")
        for row in final_stats:
            if row["earliest"] and row["latest"]:
                years = (row["latest"] - row["earliest"]).days / 365.25
                print(
                    f"{row['stock_code']:<5} | {row['records']:>7,} | {row['earliest']} | {row['latest']} | {years:>4.1f}"
                )
            else:
                print(
                    f"{row['stock_code']:<5} | {row['records']:>7,} | {'N/A':<10} | {'N/A':<10} | {'N/A':>4}"
                )

        # Show total years of data available
        total_data_years = sum(
            (row["latest"] - row["earliest"]).days / 365.25
            for row in final_stats
            if row["earliest"] and row["latest"]
        )

        print(f"\n📊 Total years of historical data: {total_data_years:.1f} years")
        print(
            f"📈 Average years per stock: {total_data_years / len(final_stats):.1f} years"
        )

    except Exception as e:
        print(f"❌ Error: {e}")
        raise
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(populate_all_stocks())
