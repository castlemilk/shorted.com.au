#!/usr/bin/env python3
"""
Continuously run batch enrichments via the enrichment processor HTTP endpoint
until all stocks have key people populated.

Usage:
    python scripts/batch_enrich_until_complete.py
    
    # Check status only
    python scripts/batch_enrich_until_complete.py --check-only
    
    # Custom settings
    python scripts/batch_enrich_until_complete.py --batch-size 20 --max-batches 100
"""

import argparse
import os
import sys
import time
import subprocess
from typing import Dict, Any, Optional, Tuple

# Configuration
ENRICHMENT_SERVICE_URL = os.getenv(
    "ENRICHMENT_SERVICE_URL",
    "https://enrichment-processor-pr-65-234770780438.australia-southeast2.run.app"
)
DB_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://admin:password@localhost:5438/shorts"
)


def run_psql_query(query: str) -> Tuple[bool, str]:
    """Run a PostgreSQL query and return (success, result)."""
    try:
        result = subprocess.run(
            ["psql", DB_URL, "-t", "-c", query],
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode == 0:
            return True, result.stdout.strip()
        return False, result.stderr
    except Exception as e:
        return False, str(e)


def get_enrichment_stats() -> Dict[str, Any]:
    """Get enrichment statistics from the database."""
    query = """
        SELECT 
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE COALESCE(enrichment_status, '') = 'completed') AS enriched,
            COUNT(*) FILTER (WHERE COALESCE(enrichment_status, '') NOT IN ('completed', 'failed') OR enrichment_status IS NULL) AS unenriched,
            COUNT(*) FILTER (WHERE key_people IS NOT NULL AND key_people != '[]'::jsonb) AS with_key_people,
            COUNT(*) FILTER (WHERE enrichment_status = 'completed' AND (key_people IS NULL OR key_people = '[]'::jsonb)) AS enriched_no_people,
            COUNT(*) FILTER (WHERE enrichment_status = 'completed' AND key_people IS NOT NULL AND key_people != '[]'::jsonb AND key_people_enriched_at IS NULL) AS need_people_backfill
        FROM "company-metadata"
    """
    
    success, result = run_psql_query(query)
    
    if not success:
        print(f"Error querying database: {result}")
        return {"error": result}
    
    lines = result.strip().split('\n')
    if not lines:
        return {"error": "No data returned"}
    
    # Parse the first line - PostgreSQL output uses | as separator
    # Example: "  4315 |       38 |       4277 |              35"
    first_line = lines[0].strip()
    parts = [p.strip() for p in first_line.split('|')]
    
    if len(parts) < 4:
        return {"error": f"Invalid data format: {parts}"}
    
    try:
        total = int(parts[0])
        enriched = int(parts[1])
        unenriched = int(parts[2])
        with_key_people = int(parts[3])
        enriched_no_people = int(parts[4]) if len(parts) > 4 else 0
        need_backfill = int(parts[5]) if len(parts) > 5 else 0
        
        return {
            "total": total,
            "enriched": enriched,
            "unenriched": unenriched,
            "with_key_people": with_key_people,
            "enriched_no_people": enriched_no_people,
            "need_people_backfill": need_backfill,
            "coverage_percent": (enriched / total * 100) if total > 0 else 0,
        }
    except (ValueError, IndexError) as e:
        return {"error": f"Failed to parse result: {e}"}


def print_status(stats: Dict[str, Any]):
    """Print enrichment status in a formatted way."""
    if "error" in stats:
        print(f"Error: {stats['error']}")
        return
    
    print("\n" + "="*60)
    print("ENRICHMENT STATUS")
    print("="*60)
    print(f"  Total stocks:           {stats.get('total', 'N/A')}")
    print(f"  Enriched (completed):   {stats.get('enriched', 'N/A')}")
    print(f"  Unenriched:             {stats.get('unenriched', 'N/A')}")
    print(f"  With key people:        {stats.get('with_key_people', 'N/A')}")
    print(f"  Enriched but no people: {stats.get('enriched_no_people', 'N/A')}")
    print(f"  Need people backfill:   {stats.get('need_people_backfill', 'N/A')}")
    print("-"*60)
    print(f"  Coverage:               {stats.get('coverage_percent', 0):.1f}%")
    print("="*60)


def run_batch_enrichment(batch_size: int, include_stale: bool = True) -> Dict[str, Any]:
    """Run a batch enrichment via the HTTP endpoint."""
    import requests
    
    url = f"{ENRICHMENT_SERVICE_URL}/enrich-batch"
    params = {
        "limit": batch_size,
        "include_stale": "true" if include_stale else "false",
        "auto_approve": "true",
        "force": "false",
    }
    
    print(f"\nCalling {url}...")
    print(f"Params: {params}")
    
    try:
        response = requests.post(url, params=params, timeout=3600)
        
        if response.status_code == 200:
            text = response.text
            
            if "No stocks need enrichment" in text:
                return {"done": True, "message": "No stocks need enrichment"}
            
            # Show last few lines
            lines = text.split('\n')
            print("\n".join(lines[-20:]))
            
            return {"done": False, "success": True}
        else:
            return {"done": False, "error": f"HTTP {response.status_code}: {response.text[:200]}"}
    
    except requests.exceptions.Timeout:
        return {"done": False, "error": "Request timed out (this is normal for large batches)"}
    except Exception as e:
        return {"done": False, "error": str(e)}


def run_people_backfill(limit: int = 50) -> Dict[str, Any]:
    """Run people backfill via the HTTP endpoint."""
    import requests
    
    url = f"{ENRICHMENT_SERVICE_URL}/backfill-people"
    params = {"limit": limit}
    
    print(f"\nRunning people backfill (limit={limit})...")
    
    try:
        response = requests.post(url, params=params, timeout=3600)
        
        if response.status_code == 200:
            text = response.text
            lines = text.split('\n')
            print("\n".join(lines[-10:]))
            return {"success": True}
        else:
            return {"error": f"HTTP {response.status_code}"}
    
    except Exception as e:
        return {"error": str(e)}


def main():
    global ENRICHMENT_SERVICE_URL
    
    parser = argparse.ArgumentParser(description="Continuously enrich stocks until all have key people")
    parser.add_argument("--check-only", action="store_true", help="Only check status, don't run enrichment")
    parser.add_argument("--batch-size", type=int, default=10, help="Number of stocks per batch (default: 10)")
    parser.add_argument("--max-batches", type=int, default=1000, help="Maximum number of batches (default: 1000)")
    parser.add_argument("--service-url", default=ENRICHMENT_SERVICE_URL, help="Enrichment service URL")
    parser.add_argument("--no-backfill", action="store_true", help="Skip people backfill step")
    
    args = parser.parse_args()
    
    ENRICHMENT_SERVICE_URL = args.service_url
    
    print("="*60)
    print("ENRICH UNTIL COMPLETE")
    print("="*60)
    print(f"Service URL: {ENRICHMENT_SERVICE_URL}")
    print(f"Batch size: {args.batch_size}")
    print(f"Max batches: {args.max_batches}")
    print(f"Started at: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*60)
    
    # Get initial status
    print("\nFetching current status...")
    stats = get_enrichment_stats()
    
    if "error" in stats:
        print(f"Failed to get status: {stats['error']}")
        sys.exit(1)
    
    print_status(stats)
    
    if args.check_only:
        return
    
    # Check if we're done
    if stats.get("unenriched", 0) == 0 and stats.get("need_people_backfill", 0) == 0:
        print("\n✓ All stocks already enriched and have key people populated!")
        return
    
    # Run batch enrichments
    print(f"\nStarting batch enrichment...")
    print("="*60)
    
    total_processed = 0
    batch_num = 0
    
    try:
        while batch_num < args.max_batches:
            batch_num += 1
            
            print(f"\n{'='*60}")
            print(f"BATCH {batch_num}/{args.max_batches}")
            print("="*60)
            
            result = run_batch_enrichment(args.batch_size)
            
            if result.get("done"):
                print("\n✓ Batch enrichment complete - no more stocks need enrichment!")
                break
            
            if result.get("error"):
                print(f"Warning: {result['error']}")
            
            total_processed += args.batch_size
            
            # Check current status
            stats = get_enrichment_stats()
            if "error" not in stats:
                print_status(stats)
                
                # Check if we're done
                if stats.get("unenriched", 0) == 0:
                    print("\n✓ All stocks have been enriched!")
                    break
            
            # Run people backfill periodically
            if not args.no_backfill and batch_num % 5 == 0:
                run_people_backfill(50)
            
            # Brief pause between batches
            print("\nPausing 5 seconds before next batch...")
            time.sleep(5)
    
    except KeyboardInterrupt:
        print("\n\nInterrupted by user.")
    
    # Final people backfill
    if not args.no_backfill:
        run_people_backfill(100)
    
    # Final status
    print("\n" + "="*60)
    print("FINAL SUMMARY")
    print("="*60)
    print(f"  Total batches run: {batch_num}")
    print(f"  Total processed:   ~{total_processed}")
    
    final_stats = get_enrichment_stats()
    print_status(final_stats)
    
    print(f"\nCompleted at: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*60)


if __name__ == "__main__":
    main()
