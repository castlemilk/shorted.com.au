#!/usr/bin/env python3
"""
Sync Company Logos from GCS to Database

This script:
1. Fetches all stock codes from the database
2. Checks which logos exist in GCS (.png files)
3. Updates logo_gcs_url in the database for stocks with logos

Usage:
    python sync-logos.py [--dry-run] [--limit N]
"""

import os
import sys
import httpx
from sqlalchemy import create_engine, text
from tqdm import tqdm
import argparse

# Configuration
GCS_LOGO_BASE_URL = "https://storage.googleapis.com/shorted-company-logos/logos"
DATABASE_URL = os.getenv(
    "DATABASE_URL", 
    "postgresql://admin:password@localhost:5438/shorts"
)

def check_logo_exists(stock_code: str) -> bool:
    """Check if a logo exists in GCS"""
    url = f"{GCS_LOGO_BASE_URL}/{stock_code.upper()}.png"
    try:
        response = httpx.head(url, timeout=5, follow_redirects=True)
        return response.status_code == 200
    except Exception as e:
        print(f"  ⚠️  Error checking {stock_code}: {e}")
        return False

def get_stocks_needing_sync(engine, table_name: str = "company-metadata") -> list:
    """Get all stocks that need logo sync"""
    query = text(f"""
        SELECT stock_code, company_name, logo_gcs_url
        FROM "{table_name}"
        ORDER BY stock_code
    """)
    
    with engine.connect() as conn:
        result = conn.execute(query)
        return [
            {
                'stock_code': row[0],
                'company_name': row[1],
                'current_logo_url': row[2]
            }
            for row in result
        ]

def update_logo_url(engine, stock_code: str, table_name: str = "company-metadata", dry_run: bool = False) -> bool:
    """Update logo_gcs_url for a stock"""
    logo_url = f"{GCS_LOGO_BASE_URL}/{stock_code.upper()}.png"
    
    if dry_run:
        print(f"  [DRY RUN] Would update {stock_code}: {logo_url}")
        return True
    
    query = text(f"""
        UPDATE "{table_name}"
        SET logo_gcs_url = :logo_url
        WHERE stock_code = :stock_code
    """)
    
    try:
        with engine.connect() as conn:
            conn.execute(query, {"logo_url": logo_url, "stock_code": stock_code})
            conn.commit()
        return True
    except Exception as e:
        print(f"  ❌ Error updating {stock_code}: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description='Sync company logos from GCS to database')
    parser.add_argument('--dry-run', action='store_true', help='Preview changes without updating')
    parser.add_argument('--limit', type=int, help='Limit number of stocks to process')
    parser.add_argument('--table', type=str, default='company-metadata', help='Table name (default: company-metadata, prod: metadata)')
    args = parser.parse_args()
    
    print("🎨 Company Logo Sync Tool")
    print("=" * 60)
    print(f"GCS Base URL: {GCS_LOGO_BASE_URL}")
    print(f"Database: {DATABASE_URL.split('@')[1]}")  # Hide credentials
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE UPDATE'}")
    print("=" * 60)
    print()
    
    # Connect to database
    engine = create_engine(DATABASE_URL)
    
    # Get all stocks
    print("📋 Fetching stock list from database...")
    print(f"Table: {args.table}")
    stocks = get_stocks_needing_sync(engine, args.table)
    print(f"✓ Found {len(stocks)} stocks")
    print()
    
    if args.limit:
        stocks = stocks[:args.limit]
        print(f"⚠️  Limited to first {args.limit} stocks")
        print()
    
    # Check which logos exist and update
    print("🔍 Checking GCS for logos and updating database...")
    print()
    
    stats = {
        'checked': 0,
        'found': 0,
        'updated': 0,
        'already_set': 0,
        'not_found': 0,
        'errors': 0
    }
    
    for stock in tqdm(stocks, desc="Processing stocks"):
        stock_code = stock['stock_code']
        current_url = stock['current_logo_url']
        stats['checked'] += 1
        
        # Check if logo exists in GCS
        if check_logo_exists(stock_code):
            stats['found'] += 1
            expected_url = f"{GCS_LOGO_BASE_URL}/{stock_code.upper()}.png"
            
            # Only update if URL is different or empty
            if current_url != expected_url:
                if update_logo_url(engine, stock_code, args.table, args.dry_run):
                    stats['updated'] += 1
                    tqdm.write(f"  ✓ {stock_code}: Updated logo URL")
                else:
                    stats['errors'] += 1
            else:
                stats['already_set'] += 1
        else:
            stats['not_found'] += 1
    
    # Print summary
    print()
    print("=" * 60)
    print("📊 Summary")
    print("=" * 60)
    print(f"Stocks checked:      {stats['checked']}")
    print(f"Logos found in GCS:  {stats['found']}")
    print(f"Database updated:    {stats['updated']}")
    print(f"Already correct:     {stats['already_set']}")
    print(f"Not found in GCS:    {stats['not_found']}")
    print(f"Errors:              {stats['errors']}")
    print()
    
    if args.dry_run:
        print("💡 This was a dry run. Run without --dry-run to apply changes.")
    else:
        print("✅ Logo sync complete!")

if __name__ == "__main__":
    main()
