#!/usr/bin/env python3
"""
Financial Reports GCS Sync

Downloads financial report PDFs from source URLs and uploads to Google Cloud Storage.
Maintains both source URLs (source of truth) and GCS URLs (our backup) in the database.

Workflow:
1. Query reports with sync_status = 'pending'
2. Download PDF from source_url
3. Verify file integrity (size, type)
4. Upload to GCS bucket
5. Update database with GCS URL and sync status
"""

import os
import hashlib
import mimetypes
from typing import Dict, Any, Optional, List
from datetime import datetime
from urllib.parse import urlparse
import time

import httpx
from google.cloud import storage
from sqlalchemy import create_engine, text
from dotenv import load_dotenv
from tqdm import tqdm

# Load environment variables from .env file
load_dotenv()

# Configuration (must be set in .env file)
GCS_BUCKET_NAME = os.getenv("GCS_FINANCIAL_REPORTS_BUCKET", "shorted-financial-reports")
DATABASE_URL = os.getenv("DATABASE_URL")
MAX_FILE_SIZE_MB = 50  # Maximum PDF size to download
TIMEOUT_SECONDS = 60
MAX_RETRIES = 3

# Validate required environment variables
if not DATABASE_URL:
    raise ValueError(
        "DATABASE_URL environment variable is required. Please set it in .env file"
    )


def calculate_file_hash(file_content: bytes) -> str:
    """Calculate SHA256 hash of file content"""
    return hashlib.sha256(file_content).hexdigest()


def download_pdf(url: str) -> Optional[bytes]:
    """
    Download PDF from URL with retries.

    Returns:
        PDF content as bytes, or None if failed
    """
    for attempt in range(MAX_RETRIES):
        try:
            response = httpx.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
                },
                timeout=TIMEOUT_SECONDS,
                follow_redirects=True,
            )

            if response.status_code == 200:
                content_type = response.headers.get("content-type", "").lower()
                content_length = len(response.content)

                # Validate it's a PDF
                if "pdf" not in content_type and not response.content.startswith(
                    b"%PDF"
                ):
                    raise ValueError(f"Not a PDF file (content-type: {content_type})")

                # Check size
                if content_length > MAX_FILE_SIZE_MB * 1024 * 1024:
                    raise ValueError(
                        f"File too large: {content_length / 1024 / 1024:.1f}MB"
                    )

                return response.content

            elif response.status_code == 404:
                raise ValueError("File not found (404)")

            else:
                raise ValueError(f"HTTP {response.status_code}")

        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2**attempt)  # Exponential backoff
                continue
            else:
                raise Exception(f"Failed after {MAX_RETRIES} attempts: {e}")

    return None


def upload_to_gcs(
    content: bytes,
    gcs_path: str,
    bucket_name: str = GCS_BUCKET_NAME,
    metadata: Optional[Dict[str, str]] = None,
) -> str:
    """
    Upload file content to Google Cloud Storage.

    Returns:
        Public GCS URL
    """
    try:
        # Initialize GCS client
        storage_client = storage.Client()
        bucket = storage_client.bucket(bucket_name)
        blob = bucket.blob(gcs_path)

        # Set metadata
        if metadata:
            blob.metadata = metadata

        # Upload
        blob.upload_from_string(content, content_type="application/pdf")

        # Make publicly readable (optional, based on your needs)
        # blob.make_public()

        # Return GCS URL
        return f"https://storage.googleapis.com/{bucket_name}/{gcs_path}"

    except Exception as e:
        raise Exception(f"GCS upload failed: {e}")


def sync_report(
    report_id: int,
    stock_code: str,
    source_url: str,
    report_type: str,
    report_date: Optional[str],
) -> Dict[str, Any]:
    """
    Sync a single report to GCS.

    Returns:
        Dictionary with sync status and details
    """
    result = {
        "report_id": report_id,
        "stock_code": stock_code,
        "source_url": source_url,
        "success": False,
        "error": None,
    }

    try:
        print(f"  📥 Downloading from source...")

        # Download from source
        content = download_pdf(source_url)
        if not content:
            raise Exception("Download failed")

        file_size = len(content)
        file_hash = calculate_file_hash(content)

        print(f"    ✅ Downloaded {file_size / 1024:.1f}KB (hash: {file_hash[:8]}...)")

        # Generate GCS path
        # Format: STOCK_CODE/YYYY-TYPE-hash.pdf
        parsed_url = urlparse(source_url)
        original_filename = os.path.basename(parsed_url.path)

        if report_date:
            year = report_date[:4]
            gcs_filename = f"{year}-{report_type}-{file_hash[:8]}.pdf"
        else:
            gcs_filename = f"{report_type}-{file_hash[:8]}.pdf"

        gcs_path = f"{stock_code}/{gcs_filename}"

        print(f"  📤 Uploading to GCS: {gcs_path}")

        # Upload to GCS
        gcs_url = upload_to_gcs(
            content,
            gcs_path,
            metadata={
                "stock_code": stock_code,
                "report_type": report_type,
                "source_url": source_url,
                "file_hash": file_hash,
                "synced_at": datetime.now().isoformat(),
            },
        )

        print(f"    ✅ Uploaded successfully")

        result.update(
            {
                "success": True,
                "gcs_url": gcs_url,
                "gcs_path": gcs_path,
                "file_size": file_size,
                "file_hash": file_hash,
            }
        )

    except Exception as e:
        result["error"] = str(e)
        print(f"    ❌ Error: {e}")

    return result


def update_sync_status(engine, report_id: int, sync_result: Dict[str, Any]):
    """Update database with sync result"""

    with engine.connect() as conn:
        if sync_result["success"]:
            query = text(
                """
                UPDATE financial_report_files
                SET 
                    gcs_url = :gcs_url,
                    gcs_path = :gcs_path,
                    gcs_synced_at = CURRENT_TIMESTAMP,
                    file_size_bytes = :file_size,
                    file_hash = :file_hash,
                    sync_status = 'uploaded',
                    sync_error = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = :report_id
            """
            )

            conn.execute(
                query,
                {
                    "report_id": report_id,
                    "gcs_url": sync_result["gcs_url"],
                    "gcs_path": sync_result["gcs_path"],
                    "file_size": sync_result["file_size"],
                    "file_hash": sync_result["file_hash"],
                },
            )
        else:
            query = text(
                """
                UPDATE financial_report_files
                SET 
                    sync_status = 'failed',
                    sync_error = :error,
                    sync_attempts = sync_attempts + 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = :report_id
            """
            )

            conn.execute(query, {"report_id": report_id, "error": sync_result["error"]})

        conn.commit()


def sync_pending_reports(
    limit: Optional[int] = None, stock_codes: Optional[List[str]] = None
):
    """
    Sync all pending reports to GCS.

    Args:
        limit: Maximum number of reports to sync
        stock_codes: Only sync reports for specific stock codes
    """
    engine = create_engine(DATABASE_URL)

    # Query pending reports
    query = """
        SELECT 
            id,
            stock_code,
            report_type,
            report_date,
            source_url,
            sync_attempts
        FROM financial_report_files
        WHERE sync_status = 'pending'
          AND sync_attempts < :max_retries
          AND source_available = true
    """

    if stock_codes:
        query += f" AND stock_code IN ({','.join([f':code_{i}' for i in range(len(stock_codes))])})"

    query += " ORDER BY created_at ASC"

    if limit:
        query += f" LIMIT {limit}"

    params = {"max_retries": MAX_RETRIES}
    if stock_codes:
        params.update({f"code_{i}": code for i, code in enumerate(stock_codes)})

    with engine.connect() as conn:
        result = conn.execute(text(query), params)
        reports = result.fetchall()

    if not reports:
        print("✅ No pending reports to sync")
        return

    print(f"\n{'=' * 80}")
    print(f"📦 Syncing {len(reports)} financial reports to GCS")
    print(f"{'=' * 80}\n")

    stats = {"total": len(reports), "success": 0, "failed": 0}

    for report in tqdm(reports, desc="Syncing reports"):
        report_id, stock_code, report_type, report_date, source_url, sync_attempts = (
            report
        )

        print(f"\n{stock_code} - {report_type} (attempt {sync_attempts + 1})")
        print(f"  Source: {source_url[:80]}...")

        # Sync report
        sync_result = sync_report(
            report_id, stock_code, source_url, report_type, report_date
        )

        # Update database
        update_sync_status(engine, report_id, sync_result)

        if sync_result["success"]:
            stats["success"] += 1
        else:
            stats["failed"] += 1

        # Be nice to servers
        time.sleep(1)

    # Print summary
    print(f"\n{'=' * 80}")
    print(f"📊 SYNC SUMMARY")
    print(f"{'=' * 80}")
    print(f"  Total:   {stats['total']}")
    print(f"  ✅ Success: {stats['success']}")
    print(f"  ❌ Failed:  {stats['failed']}")
    print(f"{'=' * 80}\n")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Sync financial reports to GCS")
    parser.add_argument("--limit", type=int, help="Maximum number of reports to sync")
    parser.add_argument(
        "--stocks", nargs="+", help="Only sync reports for these stock codes"
    )

    args = parser.parse_args()

    sync_pending_reports(limit=args.limit, stock_codes=args.stocks)
