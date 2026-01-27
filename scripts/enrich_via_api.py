#!/usr/bin/env python3
"""
Enrich companies via the API service.

Usage:
    # Enrich specific stocks
    python scripts/enrich_via_api.py --stocks DMP 4DS CBA
    
    # Enrich batch of N pending companies
    python scripts/enrich_via_api.py --batch 10
    
    # Enrich batch with auto-approve (applies enrichments immediately)
    python scripts/enrich_via_api.py --batch 10 --auto-approve
    
    # Use production API
    python scripts/enrich_via_api.py --batch 10 --auto-approve --api-url https://api.shorted.com.au
    
    # Check job status
    python scripts/enrich_via_api.py --status
    
    # List pending enrichments for review
    python scripts/enrich_via_api.py --review
"""

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import List, Optional, Dict, Any

import requests
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configuration
PREVIEW_API_URL = os.getenv(
    "PREVIEW_API_URL", 
    "https://shorts-service-pr-44-ak2zgjnhlq-km.a.run.app"
)
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "dev-internal-secret")
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "ben.ebsworth@gmail.com")


@dataclass
class APIClient:
    """Client for the Shorted API."""
    
    base_url: str
    headers: Dict[str, str]
    
    @classmethod
    def create(cls, base_url: str = PREVIEW_API_URL) -> "APIClient":
        """Create an API client with auth headers."""
        return cls(
            base_url=base_url,
            headers={
                "Content-Type": "application/json",
                "X-Internal-Secret": INTERNAL_SECRET,
                "X-User-Email": ADMIN_EMAIL,
                "X-User-Id": "enrichment-script",
            }
        )
    
    def _call(self, method: str, payload: Dict[str, Any], timeout: int = 30) -> Dict[str, Any]:
        """Make an API call."""
        url = f"{self.base_url}/shorts.v1alpha1.ShortedStocksService/{method}"
        try:
            response = requests.post(url, json=payload, headers=self.headers, timeout=timeout)
            if response.status_code == 200:
                return response.json()
            return {"error": response.text, "status_code": response.status_code}
        except Exception as e:
            return {"error": str(e)}
    
    def enrich_stock(self, stock_code: str, force: bool = False) -> Dict[str, Any]:
        """Trigger enrichment for a stock."""
        return self._call("EnrichStock", {"stockCode": stock_code, "force": force})
    
    def get_job_status(self, job_id: str) -> Dict[str, Any]:
        """Get enrichment job status."""
        return self._call("GetEnrichmentJobStatus", {"jobId": job_id})
    
    def list_jobs(self, page_size: int = 20, status: Optional[str] = None) -> Dict[str, Any]:
        """List enrichment jobs."""
        payload = {"pageSize": page_size}
        if status:
            payload["status"] = status
        return self._call("ListEnrichmentJobs", payload)
    
    def list_pending_enrichments(self, page_size: int = 20) -> Dict[str, Any]:
        """List pending enrichments for review."""
        return self._call("ListPendingEnrichments", {"pageSize": page_size})
    
    def get_pending_enrichment(self, enrichment_id: str) -> Dict[str, Any]:
        """Get a pending enrichment by ID."""
        return self._call("GetPendingEnrichment", {"enrichmentId": enrichment_id})
    
    def get_top_stocks_for_enrichment(self, limit: int = 10) -> Dict[str, Any]:
        """Get top stocks that need enrichment."""
        return self._call("GetTopStocksForEnrichment", {"limit": limit})
    
    def review_enrichment(self, enrichment_id: str, approve: bool, notes: str = "") -> Dict[str, Any]:
        """Approve or reject a pending enrichment."""
        return self._call("ReviewEnrichment", {
            "enrichmentId": enrichment_id,
            "approve": approve,
            "reviewNotes": notes
        })


def enrich_stocks(client: APIClient, stock_codes: List[str], force: bool = False) -> List[Dict]:
    """Enrich a list of stocks and return job info."""
    jobs = []
    
    print(f"\n{'='*60}")
    print(f"ENRICHING {len(stock_codes)} STOCKS")
    print(f"{'='*60}")
    
    for stock_code in stock_codes:
        print(f"\nTriggering enrichment for {stock_code}...", end=" ")
        result = client.enrich_stock(stock_code.upper(), force=force)
        
        if "jobId" in result:
            print(f"✓ Job: {result['jobId'][:8]}...")
            jobs.append({
                "stock_code": stock_code,
                "job_id": result["jobId"],
                "status": "QUEUED"
            })
        else:
            print(f"✗ {result.get('error', 'Unknown error')[:50]}")
            jobs.append({
                "stock_code": stock_code,
                "error": result.get("error", "Unknown error")
            })
        
        time.sleep(0.5)  # Brief pause between requests
    
    return jobs


def monitor_jobs(client: APIClient, jobs: List[Dict], poll_interval: int = 15, max_wait: int = 600, auto_approve: bool = False) -> List[Dict]:
    """Monitor jobs until completion or timeout."""
    
    print(f"\n{'='*60}")
    print(f"MONITORING {len(jobs)} JOBS" + (" (auto-approve enabled)" if auto_approve else ""))
    print(f"{'='*60}")
    
    job_ids = {j["stock_code"]: j["job_id"] for j in jobs if "job_id" in j}
    completed = {}
    
    start_time = time.time()
    
    while len(completed) < len(job_ids) and (time.time() - start_time) < max_wait:
        time.sleep(poll_interval)
        elapsed = int(time.time() - start_time)
        
        print(f"\n[{elapsed}s] Checking status...")
        
        for stock_code, job_id in job_ids.items():
            if stock_code in completed:
                continue
            
            result = client.get_job_status(job_id)
            job = result.get("job", {})
            status = job.get("status", "UNKNOWN").replace("ENRICHMENT_JOB_STATUS_", "")
            
            print(f"  {stock_code}: {status}")
            
            if status == "COMPLETED":
                enrichment_id = job.get("enrichmentId")
                completed[stock_code] = {
                    "status": "completed",
                    "enrichment_id": enrichment_id,
                    "duration_ms": job.get("durationMs", 0)
                }
                # Auto-approve if enabled
                if auto_approve and enrichment_id:
                    print(f"    Auto-approving {stock_code}...", end=" ")
                    approve_result = client.review_enrichment(enrichment_id, True, "Auto-approved via batch script")
                    if "error" in approve_result:
                        print(f"✗ {approve_result.get('error', 'Unknown error')[:50]}")
                        completed[stock_code]["auto_approved"] = False
                    else:
                        print("✓")
                        completed[stock_code]["auto_approved"] = True
            elif status == "FAILED":
                completed[stock_code] = {
                    "status": "failed",
                    "error": job.get("errorMessage", "Unknown error")
                }
    
    # Update jobs with final status
    for job in jobs:
        if job["stock_code"] in completed:
            job.update(completed[job["stock_code"]])
        elif "job_id" in job:
            job["status"] = "timeout"
    
    return jobs


def print_results(client: APIClient, jobs: List[Dict]):
    """Print enrichment results."""
    
    print(f"\n{'='*60}")
    print("RESULTS")
    print(f"{'='*60}")
    
    for job in jobs:
        stock = job["stock_code"]
        status = job.get("status", "unknown")
        
        print(f"\n{'-'*60}")
        print(f"{stock}: {status.upper()}")
        
        if status == "completed" and job.get("enrichment_id"):
            enrichment = client.get_pending_enrichment(job["enrichment_id"])
            if "pending" in enrichment:
                p = enrichment["pending"]
                data = p.get("data", {})
                quality = p.get("qualityScore", {})
                
                print(f"  Quality Score: {quality.get('overallScore', 'N/A')}")
                print(f"  Tags: {data.get('tags', [])}")
                print(f"  Summary: {data.get('enhancedSummary', 'N/A')[:150]}...")
                
                if job.get("duration_ms"):
                    print(f"  Duration: {job['duration_ms']/1000:.1f}s")
        elif status == "failed":
            print(f"  Error: {job.get('error', 'Unknown')[:100]}")


def show_status(client: APIClient):
    """Show current job status."""
    
    print(f"\n{'='*60}")
    print("ENRICHMENT JOB STATUS")
    print(f"{'='*60}")
    
    result = client.list_jobs(page_size=20)
    jobs = result.get("jobs", [])
    
    if not jobs:
        print("\nNo jobs found.")
        return
    
    # Group by status
    by_status = {}
    for job in jobs:
        status = job.get("status", "UNKNOWN").replace("ENRICHMENT_JOB_STATUS_", "")
        by_status.setdefault(status, []).append(job)
    
    for status, status_jobs in by_status.items():
        print(f"\n{status} ({len(status_jobs)}):")
        for job in status_jobs[:5]:
            stock = job.get("stockCode", "?")
            job_id = job.get("jobId", "?")[:8]
            print(f"  - {stock} ({job_id}...)")
        if len(status_jobs) > 5:
            print(f"  ... and {len(status_jobs) - 5} more")


def show_pending_enrichments(client: APIClient):
    """Show pending enrichments for review."""
    
    print(f"\n{'='*60}")
    print("PENDING ENRICHMENTS FOR REVIEW")
    print(f"{'='*60}")
    
    result = client.list_pending_enrichments(page_size=20)
    enrichments = result.get("enrichments", [])
    
    if not enrichments:
        print("\nNo pending enrichments.")
        return
    
    for e in enrichments:
        stock = e.get("stockCode", "?")
        status = e.get("status", "?").replace("ENRICHMENT_STATUS_", "")
        quality = e.get("qualityScore", {}).get("overallScore", "N/A")
        enrichment_id = e.get("enrichmentId", "")
        
        print(f"\n{'-'*60}")
        print(f"{stock} - Quality: {quality} - Status: {status}")
        
        # Get full enrichment data for details
        if enrichment_id:
            full = client.get_pending_enrichment(enrichment_id)
            if "pending" in full:
                p = full["pending"]
                data = p.get("data", {})
                tags = data.get("tags", [])
                summary = data.get("enhancedSummary", "N/A")
                key_people = data.get("keyPeople", [])
                
                # Logo info (stored in data)
                logo_url = data.get("logoGcsUrl", "")
                icon_url = data.get("logoIconGcsUrl", "")
                logo_source = data.get("logoSourceUrl", "")
                logo_format = data.get("logoFormat", "")
                
                print(f"  Tags: {tags}")
                print(f"  Summary: {summary[:150]}...")
                if key_people:
                    print(f"  Key People: {', '.join(kp.get('name', '?') + ' (' + kp.get('role', '?') + ')' for kp in key_people[:3])}")
                
                # Show logo info
                if logo_url or icon_url:
                    print(f"  Logo: {'✓' if logo_url else '✗'} Icon: {'✓' if icon_url else '✗'} Format: {logo_format or 'N/A'}")
                    if logo_url:
                        print(f"    {logo_url}")
                else:
                    print(f"  Logo: ✗ (not extracted)")
            else:
                print(f"  (Could not fetch details)")
        else:
            print(f"  (No enrichment ID)")


def enrich_batch(client: APIClient, batch_size: int, force: bool = False) -> List[Dict]:
    """Get top stocks for enrichment and process them."""
    
    print(f"\n{'='*60}")
    print(f"GETTING TOP {batch_size} STOCKS FOR ENRICHMENT")
    print(f"{'='*60}")
    
    result = client.get_top_stocks_for_enrichment(limit=batch_size)
    
    if "error" in result:
        print(f"Error: {result['error']}")
        return []
    
    stocks = result.get("stocks", [])
    if not stocks:
        print("No stocks found for enrichment.")
        return []
    
    stock_codes = [s.get("stockCode") for s in stocks if s.get("stockCode")]
    print(f"Found {len(stock_codes)} stocks: {', '.join(stock_codes)}")
    
    return enrich_stocks(client, stock_codes, force=force)


def main():
    parser = argparse.ArgumentParser(description="Enrich companies via the preview API")
    parser.add_argument("--stocks", nargs="+", help="Stock codes to enrich")
    parser.add_argument("--batch", type=int, help="Enrich N stocks from priority queue")
    parser.add_argument("--force", action="store_true", help="Force re-enrichment")
    parser.add_argument("--status", action="store_true", help="Show job status")
    parser.add_argument("--review", action="store_true", help="Show pending enrichments")
    parser.add_argument("--no-monitor", action="store_true", help="Don't wait for completion")
    parser.add_argument("--auto-approve", action="store_true", help="Automatically approve completed enrichments")
    parser.add_argument("--api-url", default=PREVIEW_API_URL, help="API URL")
    
    args = parser.parse_args()
    
    client = APIClient.create(args.api_url)
    
    if args.status:
        show_status(client)
        return
    
    if args.review:
        show_pending_enrichments(client)
        return
    
    jobs = []
    
    if args.stocks:
        jobs = enrich_stocks(client, args.stocks, force=args.force)
    elif args.batch:
        jobs = enrich_batch(client, args.batch, force=args.force)
    else:
        parser.print_help()
        return
    
    if jobs and not args.no_monitor:
        jobs = monitor_jobs(client, jobs, auto_approve=args.auto_approve)
        print_results(client, jobs)
    
    # Summary
    successful = sum(1 for j in jobs if j.get("status") == "completed")
    failed = sum(1 for j in jobs if j.get("status") == "failed")
    auto_approved = sum(1 for j in jobs if j.get("auto_approved"))
    
    print(f"\n{'='*60}")
    summary = f"SUMMARY: {successful} completed, {failed} failed, {len(jobs) - successful - failed} other"
    if auto_approved > 0:
        summary += f", {auto_approved} auto-approved"
    print(summary)
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
