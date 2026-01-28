#!/usr/bin/env python3
"""
Backfill website URLs from asx_company_metadata_final.csv into company-metadata table.

This script reads website URLs from the metadata CSV and updates the company-metadata
table where website is NULL or empty.

Usage:
    python scripts/backfill-websites.py

Environment variables:
    DATABASE_URL: PostgreSQL connection string (default: postgresql://admin:password@localhost:5438/shorts)
"""

import csv
import os
import sys
from pathlib import Path

import psycopg2

# Increase CSV field size limit to handle large fields (links, images columns)
csv.field_size_limit(sys.maxsize)


def get_database_url():
    """Get database URL from environment or use default."""
    return os.getenv(
        "DATABASE_URL",
        "postgresql://admin:password@localhost:5438/shorts"
    )


def load_websites_from_csv(csv_path: str) -> dict[str, str]:
    """Load stock_code -> website mapping from CSV."""
    websites = {}
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        
        for row in reader:
            stock_code = row.get('stock_code', '').strip()
            website = row.get('website', '').strip()
            
            if stock_code and website and website.startswith('http'):
                websites[stock_code] = website
    
    return websites


def backfill_websites(websites: dict[str, str], dry_run: bool = False):
    """Update company-metadata table with website URLs."""
    database_url = get_database_url()
    
    print(f"Connecting to database...")
    conn = psycopg2.connect(database_url)
    
    try:
        cursor = conn.cursor()
        
        # Count how many need updating
        cursor.execute("""
            SELECT COUNT(*) FROM "company-metadata" 
            WHERE website IS NULL OR website = ''
        """)
        missing_count = cursor.fetchone()[0]
        print(f"Found {missing_count} stocks with missing website in database")
        print(f"CSV has {len(websites)} stocks with website URLs")
        
        # Update websites where missing
        updated = 0
        skipped = 0
        not_found = 0
        
        for stock_code, website in websites.items():
            # Check if stock exists and needs update
            cursor.execute("""
                SELECT website FROM "company-metadata" WHERE stock_code = %s
            """, (stock_code,))
            
            result = cursor.fetchone()
            
            if result is None:
                not_found += 1
                continue
            
            current_website = result[0]
            
            if current_website and current_website.strip():
                skipped += 1
                continue
            
            if dry_run:
                print(f"  [DRY RUN] Would update {stock_code}: {website}")
            else:
                cursor.execute("""
                    UPDATE "company-metadata" 
                    SET website = %s 
                    WHERE stock_code = %s AND (website IS NULL OR website = '')
                """, (website, stock_code))
            
            updated += 1
        
        if not dry_run:
            conn.commit()
        
        print(f"\nResults:")
        print(f"  Updated: {updated}")
        print(f"  Skipped (already has website): {skipped}")
        print(f"  Not found in database: {not_found}")
        
        if dry_run:
            print("\n[DRY RUN] No changes were made. Run without --dry-run to apply changes.")
        
    finally:
        conn.close()


def main():
    # Find the CSV file
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    csv_path = project_root / "analysis" / "data" / "asx_company_metadata_final.csv"
    
    if not csv_path.exists():
        print(f"Error: CSV file not found at {csv_path}")
        sys.exit(1)
    
    print(f"Loading websites from {csv_path}")
    
    # Check for dry-run flag
    dry_run = "--dry-run" in sys.argv
    
    websites = load_websites_from_csv(str(csv_path))
    print(f"Loaded {len(websites)} website URLs from CSV")
    
    backfill_websites(websites, dry_run=dry_run)


if __name__ == "__main__":
    main()
