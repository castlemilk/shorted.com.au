#!/usr/bin/env python3
"""
Populate full ASX stock dataset with historical data
This script loads the top ASX stocks by market cap and trading volume
"""
import asyncio
import asyncpg
from datetime import datetime, date, timedelta
import random
import time

# Database configuration
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")

# Top ASX stocks by market cap and trading volume
# This represents the ASX 200 core stocks that would have the most trading activity
TOP_ASX_STOCKS = [
    # Big 4 Banks
    ('CBA', 120.00),   # Commonwealth Bank
    ('WBC', 27.00),    # Westpac
    ('ANZ', 30.00),    # ANZ Bank
    ('NAB', 37.00),    # National Australia Bank
    
    # Mining & Resources
    ('BHP', 45.00),    # BHP Group
    ('RIO', 120.00),   # Rio Tinto
    ('FMG', 22.00),    # Fortescue Metals
    ('NCM', 26.00),    # Newcrest Mining
    ('WDS', 35.00),    # Woodside Energy
    ('STO', 7.50),     # Santos
    ('ORG', 9.00),     # Origin Energy
    ('S32', 4.50),     # South32
    
    # Healthcare & Biotech
    ('CSL', 300.00),   # CSL Limited
    ('COH', 240.00),   # Cochlear
    ('RMD', 35.00),    # ResMed
    ('SHL', 40.00),    # Sonic Healthcare
    ('RHC', 70.00),    # Ramsay Health Care
    
    # Retail & Consumer
    ('WOW', 38.00),    # Woolworths
    ('WES', 55.00),    # Wesfarmers
    ('COL', 18.00),    # Coles Group
    ('JBH', 50.00),    # JB Hi-Fi
    ('HVN', 4.00),     # Harvey Norman
    
    # Technology
    ('XRO', 140.00),   # Xero
    ('WTC', 25.00),    # WiseTech Global
    ('ALU', 35.00),    # Altium
    ('APX', 18.00),    # Appen
    ('NEA', 2.00),     # Nearmap
    
    # Telecommunications
    ('TLS', 4.00),     # Telstra
    ('TPG', 5.50),     # TPG Telecom
    
    # Real Estate & Infrastructure
    ('GMG', 23.00),    # Goodman Group
    ('DXS', 9.00),     # Dexus
    ('SCG', 5.00),     # Scentre Group
    ('TCL', 12.00),    # Transurban
    ('REA', 180.00),   # REA Group
    ('ALL', 45.00),    # Aristocrat Leisure
    
    # Financial Services
    ('MQG', 200.00),   # Macquarie Group
    ('ASX', 65.00),    # ASX Limited
    ('QBE', 16.00),    # QBE Insurance
    ('IAG', 6.00),     # Insurance Australia Group
    ('SUN', 14.00),    # Suncorp Group
    ('AMP', 1.20),     # AMP Limited
    
    # Industrials
    ('BXB', 30.00),    # Brambles
    ('AZJ', 6.00),     # Aurizon Holdings
    ('QAN', 6.50),     # Qantas Airways
    ('SYD', 7.00),     # Sydney Airport
    
    # Utilities
    ('APA', 9.00),     # APA Group
    ('AST', 12.00),    # AusNet Services
    
    # Materials
    ('AMC', 16.00),    # Amcor
    ('JHX', 50.00),    # James Hardie
    ('BLD', 7.00),     # Boral
    ('ORI', 20.00),    # Orica
    
    # Additional ASX 100 stocks
    ('TWE', 12.00),    # Treasury Wine Estates
    ('CPU', 30.00),    # Computershare
    ('SEK', 28.00),    # SEEK
    ('CAR', 35.00),    # CAR Group
    ('RWC', 4.00),     # Reliance Worldwide
    ('NWS', 25.00),    # News Corporation
    ('EVN', 5.00),     # Evolution Mining
    ('NST', 15.00),    # Northern Star Resources
    ('PLS', 4.50),     # Pilbara Minerals
    ('MIN', 60.00),    # Mineral Resources
    ('WHC', 8.00),     # Whitehaven Coal
    ('NHF', 30.00),    # NIB Holdings
    ('MPL', 2.00),     # Medibank Private
    ('CWY', 7.00),     # Cleanaway Waste Management
    ('ALQ', 8.00),     # ALS Limited
    ('AWC', 1.50),     # Alumina Limited
    ('SGP', 5.00),     # Stockland
    ('GPT', 5.00),     # GPT Group
    ('MGR', 2.00),     # Mirvac Group
    ('CHC', 13.00),    # Charter Hall Group
    ('CIM', 2.00),     # CIMIC Group
    ('DOW', 8.00),     # Downer EDI
    ('NEC', 35.00),    # Nine Entertainment
    ('OSH', 8.00),     # Oil Search
    ('VCX', 3.00),     # Vicinity Centres
    ('IFL', 4.00),     # Insignia Financial
    ('CGF', 6.00),     # Challenger Limited
    ('BOQ', 6.00),     # Bank of Queensland
    ('BEN', 10.00),    # Bendigo and Adelaide Bank
    ('IPL', 3.00),     # Incitec Pivot
    ('NUF', 35.00),    # Nufarm
    ('SDF', 10.00),    # Steadfast Group
    ('SGM', 5.00),     # Sims Limited
    ('PRU', 2.00),     # Perseus Mining
    ('IGO', 15.00),    # IGO Limited
    ('GNC', 4.00),     # GrainCorp
    ('ILU', 10.00),    # Iluka Resources
    ('SVW', 12.00),    # Seven West Media
    ('A2M', 5.00),     # The a2 Milk Company
    ('BKL', 80.00),    # Blackmores
    ('NAN', 20.00),    # Nanosonics
    ('PDL', 5.00),     # Pendal Group
    ('PPT', 15.00),    # Perpetual
    ('EHL', 2.50),     # Emeco Holdings
    ('CTD', 25.00),    # Corporate Travel Management
    ('FLT', 20.00),    # Flight Centre Travel Group
    ('SUL', 15.00),    # Super Retail Group
    ('MTS', 3.00),     # Metcash
    ('EDV', 3.00),     # Endeavour Group
]

async def generate_stock_data(stock_code: str, base_price: float, num_days: int = 365):
    """Generate realistic stock price data for a full year"""
    data = []
    current_price = base_price
    
    start_date = date.today() - timedelta(days=num_days)
    
    # Add some long-term trend
    trend = random.choice([-0.2, -0.1, 0, 0.1, 0.2])  # Annual trend
    daily_trend = trend / 252  # Trading days per year
    
    for i in range(num_days):
        current_date = start_date + timedelta(days=i)
        
        # Skip weekends
        if current_date.weekday() >= 5:
            continue
            
        # Random daily change with trend
        volatility = random.uniform(0.01, 0.03)  # 1-3% daily volatility
        change_percent = random.gauss(daily_trend, volatility)
        daily_change = current_price * change_percent
        
        # Calculate OHLC with realistic intraday patterns
        open_price = current_price + random.uniform(-0.5, 0.5) * abs(daily_change)
        close_price = current_price + daily_change
        
        # High and low with realistic spread
        high_price = max(open_price, close_price) + abs(daily_change) * random.uniform(0.1, 0.8)
        low_price = min(open_price, close_price) - abs(daily_change) * random.uniform(0.1, 0.8)
        
        # Volume varies by stock size and volatility
        base_volume = int(base_price * 50000)  # Volume correlates with price
        volume = int(base_volume * random.uniform(0.5, 2.0) * (1 + abs(change_percent) * 10))
        
        data.append({
            'stock_code': stock_code,
            'date': current_date,
            'open': round(max(0.01, open_price), 2),
            'high': round(max(0.01, high_price), 2),
            'low': round(max(0.01, low_price), 2),
            'close': round(max(0.01, close_price), 2),
            'adjusted_close': round(max(0.01, close_price), 2),
            'volume': volume
        })
        
        current_price = close_price
    
    return data

async def populate_database():
    """Populate the database with full ASX dataset"""
    print(f"🚀 Starting full ASX dataset population...")
    print(f"📊 Loading {len(TOP_ASX_STOCKS)} stocks with 365 days of data each")
    
    # Connect to database
    conn = await asyncpg.connect(DATABASE_URL)
    
    try:
        # Clear existing stock price data
        print("🗑️  Clearing existing stock price data...")
        await conn.execute("TRUNCATE TABLE stock_prices")
        
        total_records = 0
        start_time = time.time()
        
        # Process stocks in batches
        batch_size = 10
        for i in range(0, len(TOP_ASX_STOCKS), batch_size):
            batch = TOP_ASX_STOCKS[i:i+batch_size]
            batch_records = 0
            
            print(f"\n📦 Processing batch {i//batch_size + 1}/{(len(TOP_ASX_STOCKS)-1)//batch_size + 1}")
            
            for stock_code, base_price in batch:
                print(f"  📈 Generating data for {stock_code} (base price: ${base_price:.2f})...", end='', flush=True)
                
                stock_data = await generate_stock_data(stock_code, base_price)
                
                # Bulk insert using COPY
                records = [
                    (
                        record['stock_code'],
                        record['date'],
                        record['open'],
                        record['high'],
                        record['low'],
                        record['close'],
                        record['adjusted_close'],
                        record['volume']
                    )
                    for record in stock_data
                ]
                
                await conn.copy_records_to_table(
                    'stock_prices',
                    records=records,
                    columns=['stock_code', 'date', 'open', 'high', 'low', 'close', 'adjusted_close', 'volume']
                )
                
                batch_records += len(stock_data)
                print(f" ✅ {len(stock_data)} records")
            
            total_records += batch_records
            elapsed = time.time() - start_time
            rate = total_records / elapsed
            remaining = (len(TOP_ASX_STOCKS) - i - batch_size) * (elapsed / (i + batch_size))
            
            print(f"  ⏱️  Progress: {total_records:,} records | {rate:.0f} records/sec | ETA: {remaining/60:.1f} min")
        
        # Final statistics
        elapsed_time = time.time() - start_time
        
        print(f"\n🎉 Successfully populated {total_records:,} records in {elapsed_time:.1f} seconds!")
        print(f"⚡ Average rate: {total_records/elapsed_time:.0f} records/second")
        
        # Database statistics
        print("\n📊 Database Statistics:")
        
        # Total records
        count = await conn.fetchval("SELECT COUNT(*) FROM stock_prices")
        print(f"  Total records: {count:,}")
        
        # Date range
        date_range = await conn.fetchrow("""
            SELECT MIN(date) as min_date, MAX(date) as max_date 
            FROM stock_prices
        """)
        print(f"  Date range: {date_range['min_date']} to {date_range['max_date']}")
        
        # Database size
        db_size = await conn.fetchval("""
            SELECT pg_size_pretty(pg_database_size('shorts'))
        """)
        print(f"  Database size: {db_size}")
        
        # Table size
        table_size = await conn.fetchval("""
            SELECT pg_size_pretty(pg_total_relation_size('stock_prices'))
        """)
        print(f"  Stock prices table size: {table_size}")
        
        # Index sizes
        indexes = await conn.fetch("""
            SELECT indexname, pg_size_pretty(pg_relation_size(indexrelid)) as size
            FROM pg_indexes 
            JOIN pg_class ON pg_indexes.indexname = pg_class.relname
            WHERE schemaname = 'public' AND tablename = 'stock_prices'
            ORDER BY pg_relation_size(indexrelid) DESC
        """)
        print(f"  Index sizes:")
        for idx in indexes:
            print(f"    - {idx['indexname']}: {idx['size']}")
        
        # Sample latest prices
        print("\n📋 Sample latest prices:")
        sample = await conn.fetch("""
            SELECT DISTINCT ON (stock_code) 
                stock_code, date, close, volume
            FROM stock_prices 
            WHERE stock_code IN ('CBA', 'BHP', 'CSL', 'WBC', 'RIO', 'TLS')
            ORDER BY stock_code, date DESC
        """)
        
        print("  Stock | Date       | Close   | Volume")
        print("  ------+------------+---------+---------")
        for row in sample:
            print(f"  {row['stock_code']:<5} | {row['date']} | ${row['close']:<7.2f} | {row['volume']:>9,}")
            
    finally:
        await conn.close()

if __name__ == "__main__":
    print("=" * 60)
    print("ASX Stock Data Population Script")
    print("=" * 60)
    asyncio.run(populate_database())