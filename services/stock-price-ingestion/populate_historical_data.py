#!/usr/bin/env python3
"""
Advanced historical data population script with progress tracking
"""
import os
import sys
import asyncio
import asyncpg
from datetime import datetime, date, timedelta
from typing import List, Dict, Optional, Tuple
import pandas as pd
import yfinance as yf
from tqdm import tqdm
from tqdm.asyncio import tqdm as atqdm
import click
import logging
from concurrent.futures import ThreadPoolExecutor
import signal
from dataclasses import dataclass
from rich.console import Console
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn, TimeElapsedColumn
from circuit_breaker import CircuitBreaker, CircuitBreakerConfig
from data_validation import DataValidator

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('data_ingestion.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Rich console for pretty output
console = Console()

@dataclass
class IngestionStats:
    """Track ingestion statistics"""
    total_stocks: int = 0
    successful_stocks: int = 0
    failed_stocks: int = 0
    total_records: int = 0
    validation_errors: int = 0
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None

class HistoricalDataIngestion:
    def __init__(self, db_url: str, max_workers: int = 5):
        self.db_url = db_url
        self.pool: Optional[asyncpg.Pool] = None
        self.max_workers = max_workers
        self.stats = IngestionStats()
        self.validator = DataValidator()
        self.circuit_breaker = CircuitBreaker(
            CircuitBreakerConfig(
                failure_threshold=5,
                recovery_timeout=60,
                half_open_max_calls=3
            )
        )
        # Track failed stocks for retry
        self.failed_stocks = []
        
    async def init_db(self):
        """Initialize database connection pool"""
        self.pool = await asyncpg.create_pool(
            self.db_url, 
            min_size=5, 
            max_size=20,
            command_timeout=60
        )
        
    async def close_db(self):
        """Close database connection pool"""
        if self.pool:
            await self.pool.close()
    
    async def setup_database(self):
        """Ensure database tables exist"""
        console.print("[bold blue]Setting up database tables...[/bold blue]")
        
        async with self.pool.acquire() as conn:
            # Check if tables exist
            table_exists = await conn.fetchval("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'stock_prices'
                )
            """)
            
            if not table_exists:
                console.print("[yellow]Creating database tables...[/yellow]")
                # Read and execute the schema file
                schema_path = os.path.join(os.path.dirname(__file__), '../../analysis/sql/stock_prices_schema.sql')
                if os.path.exists(schema_path):
                    with open(schema_path, 'r') as f:
                        schema_sql = f.read()
                    await conn.execute(schema_sql)
                    console.print("[green]✓ Database tables created successfully[/green]")
                else:
                    console.print("[red]Schema file not found. Please run the schema creation script first.[/red]")
                    raise FileNotFoundError("Schema file not found")
            else:
                console.print("[green]✓ Database tables already exist[/green]")
    
    def get_asx_stocks(self) -> List[str]:
        """Get list of ASX stocks to ingest"""
        # Top ASX stocks by market cap
        asx_stocks = [
            # Big Four Banks
            'CBA', 'WBC', 'ANZ', 'NAB',
            # Major Miners
            'BHP', 'RIO', 'FMG', 'NCM', 'EVN', 'NST',
            # Healthcare
            'CSL', 'COH', 'SHL', 'RMD', 'FPH',
            # Retail & Consumer
            'WOW', 'WES', 'COL', 'JBH', 'HVN',
            # Real Estate
            'GMG', 'DXS', 'MGR', 'GPT', 'SCG',
            # Financials
            'MQG', 'ASX', 'QBE', 'SUN', 'IAG',
            # Technology
            'XRO', 'WTC', 'APX', 'ALU', 'CPU',
            # Telecommunications
            'TLS', 'TPG', 'VHA',
            # Energy & Utilities
            'WDS', 'ORG', 'STO', 'APA', 'AGL',
            # Infrastructure
            'TCL', 'AIA', 'ALX', 'SYD',
            # Other Major Companies
            'AMC', 'ALL', 'AZJ', 'BXB', 'CAR',
            'CPU', 'CTD', 'DOW', 'EDV', 'GNC',
            'IFT', 'IPL', 'JHX', 'LLC', 'MPL',
            'NHF', 'NXT', 'ORA', 'ORI', 'OSH',
            'PMV', 'QAN', 'REA', 'REH', 'RHC',
            'SEK', 'SGP', 'SOL', 'TWE', 'VCX',
            'VEA', 'WHC', 'WOR', 'WPL', 'Z1P'
        ]
        
        # Remove duplicates and sort
        return sorted(list(set(asx_stocks)))
    
    async def fetch_stock_data(self, stock_code: str, start_date: date, end_date: date) -> Optional[pd.DataFrame]:
        """Fetch historical data for a single stock"""
        try:
            # Add .AX suffix for ASX stocks
            symbol = f"{stock_code}.AX" if not stock_code.endswith('.AX') else stock_code
            
            # Use circuit breaker for API calls
            async def fetch():
                loop = asyncio.get_event_loop()
                ticker = await loop.run_in_executor(None, yf.Ticker, symbol)
                df = await loop.run_in_executor(
                    None,
                    ticker.history,
                    start=start_date,
                    end=end_date,
                    interval='1d',
                    auto_adjust=False
                )
                return df
            
            df = await self.circuit_breaker.call(fetch)
            
            if df.empty:
                logger.warning(f"No data found for {stock_code}")
                return None
                
            # Prepare dataframe
            df.reset_index(inplace=True)
            df['stock_code'] = stock_code
            
            # Rename columns
            df.rename(columns={
                'Date': 'date',
                'Open': 'open',
                'High': 'high',
                'Low': 'low',
                'Close': 'close',
                'Adj Close': 'adjusted_close',
                'Volume': 'volume'
            }, inplace=True)
            
            # Validate data
            is_valid, issues = self.validator.validate_price_data(df, stock_code)
            if not is_valid:
                critical_issues = [i for i in issues if i.get('severity') == 'critical']
                logger.error(f"Critical validation errors for {stock_code}: {critical_issues}")
                self.stats.validation_errors += 1
                return None
            
            return df
            
        except Exception as e:
            logger.error(f"Error fetching {stock_code}: {str(e)}")
            return None
    
    async def insert_stock_data(self, df: pd.DataFrame) -> int:
        """Insert stock data into database"""
        if df.empty:
            return 0
            
        records_inserted = 0
        
        async with self.pool.acquire() as conn:
            # Prepare data for bulk insert
            records = []
            for _, row in df.iterrows():
                records.append((
                    row['stock_code'],
                    row['date'].date() if isinstance(row['date'], pd.Timestamp) else row['date'],
                    float(row['open']) if pd.notna(row['open']) else None,
                    float(row['high']) if pd.notna(row['high']) else None,
                    float(row['low']) if pd.notna(row['low']) else None,
                    float(row['close']),
                    float(row['adjusted_close']) if pd.notna(row['adjusted_close']) else None,
                    int(row['volume']) if pd.notna(row['volume']) else None
                ))
            
            # Use COPY for bulk insert (much faster than individual inserts)
            result = await conn.copy_records_to_table(
                'stock_prices',
                records=records,
                columns=['stock_code', 'date', 'open', 'high', 'low', 'close', 'adjusted_close', 'volume']
            )
            
            # Parse result to get number of records
            if result.startswith('COPY'):
                records_inserted = int(result.split()[1])
            
        return records_inserted
    
    async def process_stock(self, stock_code: str, start_date: date, end_date: date, progress_bar: tqdm) -> bool:
        """Process a single stock"""
        try:
            # Update progress bar description
            progress_bar.set_description(f"Processing {stock_code}")
            
            # Fetch data
            df = await self.fetch_stock_data(stock_code, start_date, end_date)
            if df is None:
                self.failed_stocks.append(stock_code)
                return False
            
            # Insert data
            records = await self.insert_stock_data(df)
            self.stats.total_records += records
            
            return True
            
        except Exception as e:
            logger.error(f"Error processing {stock_code}: {str(e)}")
            self.failed_stocks.append(stock_code)
            return False
        finally:
            # Update progress
            progress_bar.update(1)
    
    async def ingest_all_stocks(self, stocks: List[str], start_date: date, end_date: date):
        """Ingest data for all stocks with progress tracking"""
        self.stats.total_stocks = len(stocks)
        self.stats.start_time = datetime.now()
        
        console.print(f"\n[bold green]Starting ingestion of {len(stocks)} stocks[/bold green]")
        console.print(f"Date range: {start_date} to {end_date}")
        console.print(f"Using {self.max_workers} concurrent workers\n")
        
        # Create progress bar
        with tqdm(total=len(stocks), desc="Overall Progress", unit="stocks") as pbar:
            # Process stocks in batches to avoid overwhelming the API
            batch_size = self.max_workers
            for i in range(0, len(stocks), batch_size):
                batch = stocks[i:i + batch_size]
                tasks = []
                
                for stock_code in batch:
                    task = self.process_stock(stock_code, start_date, end_date, pbar)
                    tasks.append(task)
                
                # Wait for batch to complete
                results = await asyncio.gather(*tasks, return_exceptions=True)
                
                # Count successes
                for stock_code, result in zip(batch, results):
                    if isinstance(result, Exception):
                        self.stats.failed_stocks += 1
                        logger.error(f"Exception for {stock_code}: {result}")
                    elif result:
                        self.stats.successful_stocks += 1
                    else:
                        self.stats.failed_stocks += 1
                
                # Small delay between batches to be nice to the API
                await asyncio.sleep(1)
        
        self.stats.end_time = datetime.now()
    
    def print_summary(self):
        """Print ingestion summary"""
        duration = (self.stats.end_time - self.stats.start_time).total_seconds()
        
        # Create summary table
        table = Table(title="Ingestion Summary", show_header=True, header_style="bold magenta")
        table.add_column("Metric", style="cyan", no_wrap=True)
        table.add_column("Value", style="green")
        
        table.add_row("Total Stocks", str(self.stats.total_stocks))
        table.add_row("Successful", str(self.stats.successful_stocks))
        table.add_row("Failed", str(self.stats.failed_stocks))
        table.add_row("Total Records", f"{self.stats.total_records:,}")
        table.add_row("Validation Errors", str(self.stats.validation_errors))
        table.add_row("Duration", f"{duration:.1f} seconds")
        table.add_row("Rate", f"{self.stats.total_records / duration:.1f} records/second")
        
        console.print("\n")
        console.print(table)
        
        # Show failed stocks if any
        if self.failed_stocks:
            console.print(f"\n[bold red]Failed stocks ({len(self.failed_stocks)}):[/bold red]")
            console.print(", ".join(self.failed_stocks))
        
        # Show circuit breaker status
        cb_metrics = self.circuit_breaker.get_metrics()
        console.print(f"\n[bold blue]Circuit Breaker Status:[/bold blue]")
        console.print(f"State: {cb_metrics['state']}")
        console.print(f"Failures: {cb_metrics['failure_count']}")

@click.command()
@click.option('--start-date', default=None, help='Start date (YYYY-MM-DD). Default: 2 years ago')
@click.option('--end-date', default=None, help='End date (YYYY-MM-DD). Default: today')
@click.option('--stocks', default=None, help='Comma-separated list of stock codes. Default: top ASX stocks')
@click.option('--db-url', envvar='DATABASE_URL', help='PostgreSQL connection URL')
@click.option('--workers', default=5, help='Number of concurrent workers')
@click.option('--retry-failed', is_flag=True, help='Retry only previously failed stocks')
def main(start_date, end_date, stocks, db_url, workers, retry_failed):
    """Populate historical stock data with progress tracking"""
    
    # Parse dates
    if end_date:
        end_dt = datetime.strptime(end_date, '%Y-%m-%d').date()
    else:
        end_dt = date.today()
    
    if start_date:
        start_dt = datetime.strptime(start_date, '%Y-%m-%d').date()
    else:
        start_dt = end_dt - timedelta(days=730)  # 2 years
    
    # Get DB URL
    if not db_url:
        raise ValueError("DATABASE_URL environment variable is required")
    
    # Create ingestion instance
    ingestion = HistoricalDataIngestion(db_url, max_workers=workers)
    
    # Parse stocks
    if stocks:
        stock_list = [s.strip().upper() for s in stocks.split(',')]
    else:
        stock_list = ingestion.get_asx_stocks()
    
    # Run async ingestion
    async def run():
        try:
            # Initialize database
            await ingestion.init_db()
            await ingestion.setup_database()
            
            # Ingest stocks
            await ingestion.ingest_all_stocks(stock_list, start_dt, end_dt)
            
            # Print summary
            ingestion.print_summary()
            
        finally:
            await ingestion.close_db()
    
    # Handle Ctrl+C gracefully
    def signal_handler(sig, frame):
        console.print("\n[bold red]Ingestion interrupted by user[/bold red]")
        ingestion.print_summary()
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    
    # Run the async function
    asyncio.run(run())

if __name__ == "__main__":
    main()