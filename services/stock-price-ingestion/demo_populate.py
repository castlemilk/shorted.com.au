#!/usr/bin/env python3
"""
Demo historical data population script with progress tracking
"""
import asyncio
import yfinance as yf
from datetime import datetime, date, timedelta
from typing import List, Dict, Optional, Tuple
import pandas as pd
from tqdm import tqdm
import click
import logging
from rich.console import Console
from rich.table import Table

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Rich console for pretty output
console = Console()

class SimpleStockValidator:
    """Basic stock data validator"""
    
    def validate_stock_data(self, df: pd.DataFrame, stock_code: str) -> Tuple[bool, List[str]]:
        """Simple validation of stock data"""
        issues = []
        
        if df.empty:
            issues.append("No data returned")
            return False, issues
            
        # Check for required columns
        if 'Close' not in df.columns:
            issues.append("Missing Close price")
            return False, issues
            
        # Check for negative prices
        if (df['Close'] < 0).any():
            issues.append("Negative close prices found")
            return False, issues
            
        # Check OHLC relationships if all columns exist
        ohlc_cols = ['Open', 'High', 'Low', 'Close']
        if all(col in df.columns for col in ohlc_cols):
            if (df['High'] < df['Low']).any():
                issues.append("High < Low price violations")
                return False, issues
                
        return True, issues

class DemoDataIngestion:
    def __init__(self, max_workers: int = 3):
        self.max_workers = max_workers
        self.validator = SimpleStockValidator()
        self.stats = {
            'total_stocks': 0,
            'successful_stocks': 0,
            'failed_stocks': 0,
            'total_records': 0,
            'validation_errors': 0,
            'failed_list': []
        }
        
    def get_sample_asx_stocks(self) -> List[str]:
        """Get a sample of ASX stocks for demo"""
        return [
            'CBA', 'WBC', 'ANZ', 'NAB',  # Big Four Banks
            'BHP', 'RIO', 'FMG',         # Major Miners
            'CSL', 'COH',                # Healthcare
            'WOW', 'WES',                # Retail
            'TLS', 'MQG'                 # Telco & Finance
        ]
    
    async def fetch_stock_data(self, stock_code: str, start_date: date, end_date: date) -> Optional[pd.DataFrame]:
        """Fetch historical data for a single stock"""
        try:
            # Add .AX suffix for ASX stocks
            symbol = f"{stock_code}.AX"
            
            # Use thread executor for yfinance (it's synchronous)
            loop = asyncio.get_event_loop()
            ticker = await loop.run_in_executor(None, yf.Ticker, symbol)
            df = await loop.run_in_executor(
                None,
                lambda: ticker.history(
                    start=start_date,
                    end=end_date,
                    interval='1d',
                    auto_adjust=False
                )
            )
            
            if df.empty:
                logger.warning(f"No data found for {stock_code}")
                return None
                
            # Add stock code
            df['stock_code'] = stock_code
            
            # Validate data
            is_valid, issues = self.validator.validate_stock_data(df, stock_code)
            if not is_valid:
                logger.error(f"Validation failed for {stock_code}: {issues}")
                self.stats['validation_errors'] += 1
                return None
            
            return df
            
        except Exception as e:
            logger.error(f"Error fetching {stock_code}: {str(e)}")
            return None
    
    async def process_stock(self, stock_code: str, start_date: date, end_date: date) -> bool:
        """Process a single stock and return success status"""
        try:
            df = await self.fetch_stock_data(stock_code, start_date, end_date)
            if df is not None:
                self.stats['total_records'] += len(df)
                return True
            else:
                self.stats['failed_list'].append(stock_code)
                return False
                
        except Exception as e:
            logger.error(f"Error processing {stock_code}: {str(e)}")
            self.stats['failed_list'].append(stock_code)
            return False
    
    async def ingest_demo_data(self, stocks: List[str], start_date: date, end_date: date):
        """Demo ingestion with progress tracking"""
        self.stats['total_stocks'] = len(stocks)
        start_time = datetime.now()
        
        console.print(f"\n[bold green]Demo: Processing {len(stocks)} ASX stocks[/bold green]")
        console.print(f"Date range: {start_date} to {end_date}")
        console.print(f"Using {self.max_workers} concurrent workers\n")
        
        # Process with progress bar
        with tqdm(total=len(stocks), desc="Processing stocks", unit="stocks") as pbar:
            # Process in small batches to avoid overwhelming the API
            batch_size = self.max_workers
            for i in range(0, len(stocks), batch_size):
                batch = stocks[i:i + batch_size]
                
                # Process batch concurrently
                tasks = [self.process_stock(stock, start_date, end_date) for stock in batch]
                results = await asyncio.gather(*tasks, return_exceptions=True)
                
                # Update stats
                for stock, result in zip(batch, results):
                    pbar.set_description(f"Processed {stock}")
                    if isinstance(result, Exception):
                        self.stats['failed_stocks'] += 1
                        logger.error(f"Exception for {stock}: {result}")
                    elif result:
                        self.stats['successful_stocks'] += 1
                    else:
                        self.stats['failed_stocks'] += 1
                    
                    pbar.update(1)
                
                # Small delay between batches
                await asyncio.sleep(0.5)
        
        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()
        
        # Print summary
        self.print_summary(duration)
    
    def print_summary(self, duration: float):
        """Print ingestion summary"""
        # Create summary table
        table = Table(title="Demo Ingestion Summary", show_header=True, header_style="bold magenta")
        table.add_column("Metric", style="cyan", no_wrap=True)
        table.add_column("Value", style="green")
        
        table.add_row("Total Stocks", str(self.stats['total_stocks']))
        table.add_row("Successful", str(self.stats['successful_stocks']))
        table.add_row("Failed", str(self.stats['failed_stocks']))
        table.add_row("Total Records", f"{self.stats['total_records']:,}")
        table.add_row("Validation Errors", str(self.stats['validation_errors']))
        table.add_row("Duration", f"{duration:.1f} seconds")
        
        if self.stats['total_records'] > 0:
            table.add_row("Rate", f"{self.stats['total_records'] / duration:.1f} records/second")
        
        console.print("\n")
        console.print(table)
        
        # Show failed stocks if any
        if self.stats['failed_list']:
            console.print(f"\n[bold red]Failed stocks ({len(self.stats['failed_list'])}):[/bold red]")
            console.print(", ".join(self.stats['failed_list']))
        
        # Success message
        if self.stats['successful_stocks'] > 0:
            console.print(f"\n[bold green]✓ Demo completed successfully![/bold green]")
            console.print(f"Fetched {self.stats['total_records']} historical price records")
        else:
            console.print(f"\n[bold red]✗ Demo failed - no data was retrieved[/bold red]")

@click.command()
@click.option('--start-date', default=None, help='Start date (YYYY-MM-DD). Default: 1 month ago')
@click.option('--end-date', default=None, help='End date (YYYY-MM-DD). Default: today')
@click.option('--stocks', default=None, help='Comma-separated list of stock codes. Default: sample ASX stocks')
@click.option('--workers', default=3, help='Number of concurrent workers')
def main(start_date, end_date, stocks, workers):
    """Demo: Test historical stock data fetching with progress tracking"""
    
    # Parse dates
    if end_date:
        end_dt = datetime.strptime(end_date, '%Y-%m-%d').date()
    else:
        end_dt = date.today()
    
    if start_date:
        start_dt = datetime.strptime(start_date, '%Y-%m-%d').date()
    else:
        start_dt = end_dt - timedelta(days=30)  # 1 month
    
    # Create ingestion instance
    ingestion = DemoDataIngestion(max_workers=workers)
    
    # Parse stocks
    if stocks:
        stock_list = [s.strip().upper() for s in stocks.split(',')]
    else:
        stock_list = ingestion.get_sample_asx_stocks()
    
    # Run async ingestion
    async def run():
        try:
            await ingestion.ingest_demo_data(stock_list, start_dt, end_dt)
        except KeyboardInterrupt:
            console.print("\n[bold red]Demo interrupted by user[/bold red]")
            ingestion.print_summary(0)
    
    # Run the async function
    asyncio.run(run())

if __name__ == "__main__":
    main()