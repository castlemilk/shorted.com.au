#!/usr/bin/env python3
"""
Populate comprehensive ASX stocks with 10 years of real historical data
"""
import asyncio
import asyncpg
from datetime import date, timedelta
import yfinance as yf
import pandas as pd
import time

DATABASE_URL = "postgres://postgres.vfzzkelbpyjdvuujyrpu:bxmsrFPazXawzeav@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"

# Comprehensive list of ASX stocks including ASX 200 components
ASX_STOCKS = {
    # Big 4 Banks
    'CBA': 'CBA.AX',    # Commonwealth Bank
    'WBC': 'WBC.AX',    # Westpac
    'ANZ': 'ANZ.AX',    # ANZ Bank
    'NAB': 'NAB.AX',    # National Australia Bank
    
    # Mining & Resources
    'BHP': 'BHP.AX',    # BHP Group
    'RIO': 'RIO.AX',    # Rio Tinto
    'FMG': 'FMG.AX',    # Fortescue Metals
    'NCM': 'NCM.AX',    # Newcrest Mining
    'S32': 'S32.AX',    # South32
    'MIN': 'MIN.AX',    # Mineral Resources
    'IGO': 'IGO.AX',    # IGO Limited
    'OZL': 'OZL.AX',    # OZ Minerals
    'WHC': 'WHC.AX',    # Whitehaven Coal
    'NHC': 'NHC.AX',    # New Hope Corporation
    'PLS': 'PLS.AX',    # Pilbara Minerals
    'LYC': 'LYC.AX',    # Lynas Rare Earths
    
    # Energy
    'WPL': 'WPL.AX',    # Woodside Petroleum
    'STO': 'STO.AX',    # Santos
    'ORG': 'ORG.AX',    # Origin Energy
    'AGL': 'AGL.AX',    # AGL Energy
    'BPT': 'BPT.AX',    # Beach Energy
    'WDS': 'WDS.AX',    # Woodside Energy
    
    # Healthcare & Biotech
    'CSL': 'CSL.AX',    # CSL Limited
    'RHC': 'RHC.AX',    # Ramsay Health Care
    'SHL': 'SHL.AX',    # Sonic Healthcare
    'COH': 'COH.AX',    # Cochlear
    'RMD': 'RMD.AX',    # ResMed
    'PME': 'PME.AX',    # Pro Medicus
    'ANN': 'ANN.AX',    # Ansell
    'FPH': 'FPH.AX',    # Fisher & Paykel Healthcare
    
    # Retail & Consumer
    'WOW': 'WOW.AX',    # Woolworths
    'COL': 'COL.AX',    # Coles Group
    'WES': 'WES.AX',    # Wesfarmers
    'HVN': 'HVN.AX',    # Harvey Norman
    'JBH': 'JBH.AX',    # JB Hi-Fi
    'SUL': 'SUL.AX',    # Super Retail Group
    'BRG': 'BRG.AX',    # Breville Group
    'DMP': 'DMP.AX',    # Domino's Pizza
    'CWN': 'CWN.AX',    # Crown Resorts
    'A2M': 'A2M.AX',    # A2 Milk Company
    'TWE': 'TWE.AX',    # Treasury Wine Estates
    
    # Technology
    'XRO': 'XRO.AX',    # Xero
    'WTC': 'WTC.AX',    # WiseTech Global
    'ALU': 'ALU.AX',    # Altium
    'TNE': 'TNE.AX',    # Technology One
    'APX': 'APX.AX',    # Appen
    'NEA': 'NEA.AX',    # Nearmap
    'NXT': 'NXT.AX',    # NextDC
    'MP1': 'MP1.AX',    # Megaport
    
    # Telecommunications
    'TLS': 'TLS.AX',    # Telstra
    'TPG': 'TPG.AX',    # TPG Telecom
    'VHA': 'VHA.AX',    # Vocus Group
    
    # Financial Services
    'MQG': 'MQG.AX',    # Macquarie Group
    'ASX': 'ASX.AX',    # ASX Limited
    'QBE': 'QBE.AX',    # QBE Insurance
    'SUN': 'SUN.AX',    # Suncorp Group
    'IAG': 'IAG.AX',    # Insurance Australia Group
    'AMP': 'AMP.AX',    # AMP Limited
    'CCP': 'CCP.AX',    # Credit Corp Group
    'MFG': 'MFG.AX',    # Magellan Financial
    'PPT': 'PPT.AX',    # Perpetual
    'PDL': 'PDL.AX',    # Pendal Group
    
    # Real Estate & Infrastructure
    'GMG': 'GMG.AX',    # Goodman Group
    'SGP': 'SGP.AX',    # Stockland
    'MGR': 'MGR.AX',    # Mirvac Group
    'DXS': 'DXS.AX',    # Dexus
    'GPT': 'GPT.AX',    # GPT Group
    'VCX': 'VCX.AX',    # Vicinity Centres
    'SCG': 'SCG.AX',    # Scentre Group
    'CHC': 'CHC.AX',    # Charter Hall
    'LLC': 'LLC.AX',    # Lendlease
    
    # Transport & Logistics
    'QAN': 'QAN.AX',    # Qantas Airways
    'TCL': 'TCL.AX',    # Transurban
    'AZJ': 'AZJ.AX',    # Aurizon Holdings
    'ALX': 'ALX.AX',    # Atlas Arteria
    'CTX': 'CTX.AX',    # Caltex Australia
    'OSH': 'OSH.AX',    # Oil Search
    
    # Industrials
    'BXB': 'BXB.AX',    # Brambles
    'AMC': 'AMC.AX',    # Amcor
    'JHX': 'JHX.AX',    # James Hardie
    'BLD': 'BLD.AX',    # Boral
    'ALS': 'ALS.AX',    # ALS Limited
    'CIM': 'CIM.AX',    # CIMIC Group
    'SEK': 'SEK.AX',    # Seek
    'CAR': 'CAR.AX',    # Carsales.com
    'REA': 'REA.AX',    # REA Group
    'DHG': 'DHG.AX',    # Domain Holdings
    
    # Materials & Building
    'ORI': 'ORI.AX',    # Orica
    'IPL': 'IPL.AX',    # Incitec Pivot
    'AWC': 'AWC.AX',    # Alumina Limited
    'BSL': 'BSL.AX',    # BlueScope Steel
    'SVW': 'SVW.AX',    # Seven West Media
    'NEC': 'NEC.AX',    # Nine Entertainment
    
    # Agriculture
    'GNC': 'GNC.AX',    # GrainCorp
    'ELD': 'ELD.AX',    # Elders
    'CGF': 'CGF.AX',    # Challenger
    'NUF': 'NUF.AX',    # Nufarm
    
    # Gaming & Entertainment
    'TAH': 'TAH.AX',    # Tabcorp Holdings
    'ALL': 'ALL.AX',    # Aristocrat Leisure
    'SGR': 'SGR.AX',    # Star Entertainment
    'EVT': 'EVT.AX',    # Event Hospitality
    'FLT': 'FLT.AX',    # Flight Centre
    'WEB': 'WEB.AX',    # Webjet
}

def fetch_real_data(stock_code: str, yf_ticker: str, years: int = 10):
    """Fetch real historical data from yfinance"""
    print(f"  📈 Fetching {years} years of {stock_code} data...")
    
    try:
        ticker = yf.Ticker(yf_ticker)
        end_date = date.today()
        start_date = end_date - timedelta(days=years * 365)
        
        hist = ticker.history(start=start_date, end=end_date, interval='1d')
        
        if hist.empty:
            print(f"    ⚠️  No data available")
            return []
        
        # Convert to our format
        data = []
        for date_idx, row in hist.iterrows():
            if pd.isna(row['Open']) or pd.isna(row['Close']):
                continue
                
            data.append({
                'stock_code': stock_code,
                'date': date_idx.date(),
                'open': round(float(row['Open']), 2),
                'high': round(float(row['High']), 2),
                'low': round(float(row['Low']), 2),
                'close': round(float(row['Close']), 2),
                'adjusted_close': round(float(row['Close']), 2),
                'volume': int(row['Volume']) if not pd.isna(row['Volume']) else 0
            })
        
        print(f"    ✅ {len(data)} records ({data[0]['date']} to {data[-1]['date']})")
        return data
        
    except Exception as e:
        print(f"    ❌ Error: {e}")
        return []

async def update_stock(conn, stock_code: str, yf_ticker: str):
    """Update a single stock with real historical data"""
    
    # Check if stock already has substantial data (skip if already processed)
    existing = await conn.fetchrow("""
        SELECT COUNT(*) as count, MIN(date) as earliest, MAX(date) as latest
        FROM stock_prices WHERE stock_code = $1
    """, stock_code)
    
    # Skip if we already have more than 2000 records (likely already has 10 years)
    if existing['count'] and existing['count'] > 2000:
        years = (existing['latest'] - existing['earliest']).days / 365.25 if existing['earliest'] else 0
        print(f"  ⏭️  Skipping {stock_code} - already has {existing['count']:,} records ({years:.1f} years)")
        return existing['count']
    
    # Fetch real data
    data = fetch_real_data(stock_code, yf_ticker, 10)
    
    if not data:
        return 0
    
    # Delete existing data for clean replacement
    await conn.execute("DELETE FROM stock_prices WHERE stock_code = $1", stock_code)
    
    # Insert new data using batch insert for better performance
    inserted = 0
    batch_size = 100
    
    for i in range(0, len(data), batch_size):
        batch = data[i:i + batch_size]
        
        values = []
        for record in batch:
            values.append((
                record['stock_code'], record['date'], record['open'], 
                record['high'], record['low'], record['close'], 
                record['adjusted_close'], record['volume']
            ))
        
        try:
            await conn.executemany("""
                INSERT INTO stock_prices 
                (stock_code, date, open, high, low, close, adjusted_close, volume)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (stock_code, date) DO NOTHING
            """, values)
            inserted += len(values)
        except Exception as e:
            print(f"      ⚠️  Batch insert error: {e}")
            # Fallback to individual inserts
            for record in batch:
                try:
                    await conn.execute("""
                        INSERT INTO stock_prices 
                        (stock_code, date, open, high, low, close, adjusted_close, volume)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        ON CONFLICT (stock_code, date) DO NOTHING
                    """, 
                    record['stock_code'], record['date'], record['open'], 
                    record['high'], record['low'], record['close'], 
                    record['adjusted_close'], record['volume'])
                    inserted += 1
                except Exception as e2:
                    print(f"      ⚠️  Insert error for {record['date']}: {e2}")
                    continue
    
    print(f"    ✅ Inserted {inserted}/{len(data)} records")
    return inserted

async def populate_all_stocks(batch_stocks=None):
    """Populate all stocks with 10 years of real data"""
    stocks_to_process = batch_stocks if batch_stocks else ASX_STOCKS
    
    print(f"🚀 Populating {len(stocks_to_process)} ASX stocks with 10 years of real historical data")
    print("📊 This will add real market data from Yahoo Finance\n")
    
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        total_inserted = 0
        successful_stocks = 0
        failed_stocks = []
        
        for i, (stock_code, yf_ticker) in enumerate(stocks_to_process.items(), 1):
            print(f"[{i:3d}/{len(stocks_to_process)}] {stock_code} ({yf_ticker})")
            
            try:
                inserted = await update_stock(conn, stock_code, yf_ticker)
                
                if inserted > 0:
                    total_inserted += inserted
                    successful_stocks += 1
                elif inserted == 0:
                    failed_stocks.append(stock_code)
            except Exception as e:
                print(f"    ❌ Failed to process {stock_code}: {e}")
                failed_stocks.append(stock_code)
            
            # Rate limiting - be nice to Yahoo Finance
            time.sleep(1.5)
            print()
        
        # Final summary
        print(f"🎉 Population completed!")
        print(f"✅ Successfully processed: {successful_stocks}/{len(stocks_to_process)} stocks")
        print(f"➕ Records inserted: {total_inserted:,}")
        
        if failed_stocks:
            print(f"\n⚠️  Failed stocks ({len(failed_stocks)}):")
            for stock in failed_stocks:
                print(f"  - {stock}")
        
        # Show overall database statistics
        total_records = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")
        stock_count = await conn.fetchval("SELECT COUNT(DISTINCT stock_code) FROM stock_prices")
        overall_range = await conn.fetchrow("""
            SELECT MIN(date) as earliest, MAX(date) as latest FROM stock_prices
        """)
        
        print(f"\n📊 Database Statistics:")
        print(f"  Total stocks with data: {stock_count}")
        print(f"  Total records: {total_records:,}")
        print(f"  Date range: {overall_range['earliest']} to {overall_range['latest']}")
        
    except Exception as e:
        print(f"❌ Error: {e}")
        raise
    finally:
        await conn.close()

async def main():
    """Main function to run in batches"""
    # Process in batches to avoid overwhelming the API
    all_stocks = list(ASX_STOCKS.items())
    batch_size = 20
    
    for i in range(0, len(all_stocks), batch_size):
        batch = dict(all_stocks[i:i+batch_size])
        print(f"\n📦 Processing batch {i//batch_size + 1} ({len(batch)} stocks)")
        print("=" * 60)
        await populate_all_stocks(batch)
        
        if i + batch_size < len(all_stocks):
            print(f"\n⏸️  Pausing before next batch...")
            time.sleep(10)  # Pause between batches

if __name__ == "__main__":
    asyncio.run(main())