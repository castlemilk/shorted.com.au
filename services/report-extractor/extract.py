#!/usr/bin/env python3
"""
ASX Financial Report Extractor using langextract.

Downloads financial report PDFs from ASX, extracts text, and uses langextract
with Gemini Flash to extract structured financial data. Results are stored in
PostgreSQL for use by the weekly report generator.

Usage:
    # Process top 50 most-shorted stocks
    python extract.py --mode=top50 --limit=50

    # Process specific stocks
    python extract.py --codes=CBA,BHP,CSL

    # Dry run (no DB writes)
    python extract.py --codes=CBA --dry-run

    # Process all unextracted reports
    python extract.py --mode=all --limit=100
"""

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from typing import Optional

import fitz  # pymupdf
import langextract as lx
import psycopg2
import psycopg2.extras
import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y/%m/%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# Financial data extraction prompt
EXTRACTION_PROMPT = """Extract key financial metrics from this ASX company financial report.
For each metric found, extract the exact text containing the number and classify it.
Focus on the MOST RECENT reporting period (not comparative/prior period).
All monetary values should be in millions AUD unless stated otherwise.
Only extract metrics that are explicitly stated - do not calculate or infer."""

# Few-shot examples for langextract
EXTRACTION_EXAMPLES = [
    lx.data.ExampleData(
        text="""Revenue from continuing operations for the half year ended 31 December 2024
was $5,142 million, an increase of 8% on the prior corresponding period.
Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp.
Basic earnings per share was 94.2 cents.
The Board declared an interim dividend of 45 cents per share, fully franked.
Operating cash flow was $2,156 million.
EBITDA was $2,891 million, representing a margin of 56.2%.
FY2025 guidance: Revenue growth of 6-8% expected.""",
        extractions=[
            lx.data.Extraction(
                extraction_class="revenue",
                extraction_text="Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million",
                attributes={
                    "value_millions": "5142",
                    "period": "H1 FY2025",
                    "change_pct": "+8",
                },
            ),
            lx.data.Extraction(
                extraction_class="net_profit",
                extraction_text="Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp",
                attributes={
                    "value_millions": "1823",
                    "period": "H1 FY2025",
                    "change_pct": "+12",
                },
            ),
            lx.data.Extraction(
                extraction_class="eps",
                extraction_text="Basic earnings per share was 94.2 cents",
                attributes={
                    "value_cents": "94.2",
                    "period": "H1 FY2025",
                },
            ),
            lx.data.Extraction(
                extraction_class="dividend",
                extraction_text="interim dividend of 45 cents per share, fully franked",
                attributes={
                    "value_cents": "45",
                    "franking": "fully franked",
                    "period": "H1 FY2025",
                },
            ),
            lx.data.Extraction(
                extraction_class="cash_flow",
                extraction_text="Operating cash flow was $2,156 million",
                attributes={
                    "value_millions": "2156",
                    "period": "H1 FY2025",
                },
            ),
            lx.data.Extraction(
                extraction_class="ebitda",
                extraction_text="EBITDA was $2,891 million, representing a margin of 56.2%",
                attributes={
                    "value_millions": "2891",
                    "margin_pct": "56.2",
                    "period": "H1 FY2025",
                },
            ),
            lx.data.Extraction(
                extraction_class="guidance",
                extraction_text="FY2025 guidance: Revenue growth of 6-8% expected",
                attributes={
                    "metric": "revenue_growth",
                    "range": "6-8%",
                    "period": "FY2025",
                },
            ),
        ],
    ),
]

# ASX PDF download headers
ASX_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/pdf,*/*",
    "Referer": "https://www.asx.com.au/",
}


def get_db_connection():
    """Connect to PostgreSQL."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL environment variable required")
        sys.exit(1)
    return psycopg2.connect(db_url)


def get_reports_to_process(conn, mode: str, codes: list[str], limit: int, recent: int = 0) -> list[dict]:
    """Fetch financial report URLs that haven't been extracted yet."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    if mode == "codes" and codes:
        # Specific stock codes
        placeholders = ",".join(["%s"] * len(codes))
        cur.execute(
            f"""
            SELECT stock_code, financial_reports::text
            FROM "company-metadata"
            WHERE stock_code IN ({placeholders})
              AND financial_reports IS NOT NULL
              AND financial_reports::text != '[]'
              AND financial_reports::text != 'null'
            """,
            codes,
        )
    elif mode == "top50":
        # Top 50 most shorted stocks (using materialized view)
        cur.execute(
            """
            SELECT cm.stock_code, cm.financial_reports::text
            FROM "company-metadata" cm
            INNER JOIN (
                SELECT product_code
                FROM mv_top_shorts
                ORDER BY current_percent DESC
                LIMIT 50
            ) top ON cm.stock_code = top.product_code
            WHERE cm.financial_reports IS NOT NULL
              AND cm.financial_reports::text != '[]'
              AND cm.financial_reports::text != 'null'
            """
        )
    else:
        # All stocks with ASX announcement reports
        cur.execute(
            """
            SELECT stock_code, financial_reports::text
            FROM "company-metadata"
            WHERE financial_reports IS NOT NULL
              AND financial_reports::text LIKE '%asx_announcements%'
            ORDER BY stock_code
            """
        )

    rows = cur.fetchall()
    cur.close()

    # Parse and filter reports
    reports = []
    for row in rows:
        stock_code = row["stock_code"]
        try:
            fin_reports = json.loads(row["financial_reports"])
        except (json.JSONDecodeError, TypeError):
            continue

        for r in fin_reports:
            if r.get("source") != "asx_announcements":
                continue
            # Only process key report types (skip quarterly — less financial data)
            rtype = r.get("type", "")
            if rtype not in (
                "annual_results",
                "half_year_results",
                "full_year_results",
                "annual_report",
                "financial_report",
            ):
                continue
            reports.append(
                {
                    "stock_code": stock_code,
                    "url": r.get("url", ""),
                    "title": r.get("title", ""),
                    "date": r.get("date", ""),
                    "type": rtype,
                }
            )

    # Sort by date descending per company, then limit per company
    reports.sort(key=lambda r: (r["stock_code"], r["date"]), reverse=True)
    if recent > 0:
        from collections import Counter
        company_count: Counter = Counter()
        filtered = []
        for r in reports:
            if company_count[r["stock_code"]] < recent:
                filtered.append(r)
                company_count[r["stock_code"]] += 1
        reports = filtered

    # Check which reports are already extracted
    if reports:
        cur = conn.cursor()
        cur.execute(
            "SELECT report_url FROM financial_report_extractions WHERE report_url = ANY(%s)",
            ([r["url"] for r in reports],),
        )
        existing = {row[0] for row in cur.fetchall()}
        cur.close()
        reports = [r for r in reports if r["url"] not in existing]

    if limit > 0:
        reports = reports[:limit]

    return reports


def resolve_asx_pdf_url(session: requests.Session, display_url: str) -> Optional[str]:
    """Resolve an ASX displayAnnouncement URL to the actual PDF URL.

    ASX's displayAnnouncement.do shows a terms page with a hidden form field
    containing the real PDF URL at announcements.asx.com.au.
    """
    try:
        resp = session.get(display_url, timeout=15)
        if resp.status_code != 200:
            return None

        # Check if this is already a direct PDF
        if resp.content[:5] == b"%PDF-":
            return display_url

        # Extract the real PDF URL from the hidden form field
        import re

        match = re.search(r'name="pdfURL"\s+value="([^"]+)"', resp.text)
        if match:
            return match.group(1)

        return None
    except Exception as e:
        log.debug("  Failed to resolve PDF URL: %s", e)
        return None


def download_pdf_text(session: requests.Session, url: str, max_pages: int = 10) -> Optional[str]:
    """Download a PDF from ASX and extract text.

    If the URL is an ASX displayAnnouncement URL, first resolves to the real
    PDF URL at announcements.asx.com.au.
    """
    try:
        # Resolve the actual PDF URL if needed
        pdf_url = url
        if "displayAnnouncement.do" in url:
            resolved = resolve_asx_pdf_url(session, url)
            if resolved:
                pdf_url = resolved
                log.debug("  Resolved to: %s", pdf_url)
            else:
                log.warning("  Could not resolve PDF URL")
                return None

        resp = session.get(pdf_url, timeout=60)
        if resp.status_code != 200:
            log.warning("  HTTP %d for %s", resp.status_code, pdf_url)
            return None

        if resp.content[:5] != b"%PDF-":
            log.warning("  Not a PDF response")
            return None

        # Extract text with pymupdf
        doc = fitz.open(stream=resp.content, filetype="pdf")
        pages_text = []
        for i, page in enumerate(doc):
            if i >= max_pages:
                break
            pages_text.append(page.get_text())
        doc.close()

        text = "\n\n".join(pages_text)
        if len(text.strip()) < 100:
            log.warning("  Very little text extracted (%d chars)", len(text))
            return None

        return text

    except Exception as e:
        log.warning("  PDF download/extract failed: %s", e)
        return None


def extract_financial_data(text: str, stock_code: str, model_id: str = "gemini-2.5-flash") -> list[dict]:
    """Use langextract to extract structured financial data from report text."""
    # Truncate very long texts to stay within token limits
    if len(text) > 50000:
        text = text[:50000]

    try:
        result = lx.extract(
            text_or_documents=text,
            prompt_description=EXTRACTION_PROMPT,
            examples=EXTRACTION_EXAMPLES,
            model_id=model_id,
            extraction_passes=1,
            max_workers=1,
            max_char_buffer=2000,
        )

        extractions = []
        if result and hasattr(result, "extractions"):
            for ext in result.extractions:
                extractions.append(
                    {
                        "class": ext.extraction_class,
                        "text": ext.extraction_text,
                        "attributes": ext.attributes if hasattr(ext, "attributes") else {},
                    }
                )
        return extractions

    except Exception as e:
        log.warning("  langextract failed for %s: %s", stock_code, e)
        return []


def extractions_to_metrics(extractions: list[dict]) -> dict:
    """Convert langextract extractions to a structured metrics dict."""
    metrics = {}
    for ext in extractions:
        cls = ext["class"]
        attrs = ext.get("attributes") or {}
        entry = {
            "source_text": ext["text"],
            **attrs,
        }
        if cls in metrics:
            # Keep both if there are multiple (e.g., multiple revenue figures)
            if isinstance(metrics[cls], list):
                metrics[cls].append(entry)
            else:
                metrics[cls] = [metrics[cls], entry]
        else:
            metrics[cls] = entry

    return metrics


DIGEST_MODEL = "gemini-2.5-flash"

DIGEST_PROMPT = """You are summarising an ASX-listed company's financial report for a retail investor.
In 2-3 plain-English sentences, lead with the headline result (revenue and net profit direction with % change),
then the dividend, then any guidance. Be concrete with the numbers from the metrics.
Output STRICT JSON: {"digest": "...", "confidence": 0.0-1.0, "key_takeaways": ["...", "..."]}"""


def summarize_report(metrics: dict, page_text: str, model_id: str = DIGEST_MODEL) -> dict:
    """Generate a plain-English digest of the financial report using a single Gemini call.

    Returns a dict with keys: digest (str), confidence (float), key_takeaways (list[str]).
    On any failure returns digest="" confidence=0.0 key_takeaways=[].
    """
    try:
        from google import genai
        from google.genai import types as genai_types
    except ImportError:
        log.warning("  google-genai not available; skipping digest generation")
        return {"digest": "", "confidence": 0.0, "key_takeaways": []}

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("LANGEXTRACT_API_KEY")
    if not api_key:
        log.warning("  No GEMINI_API_KEY / LANGEXTRACT_API_KEY set; skipping digest")
        return {"digest": "", "confidence": 0.0, "key_takeaways": []}

    # Build context: structured metrics + truncated raw text
    metrics_json = json.dumps(metrics, indent=2)
    # Limit page text to 8000 chars to stay well within token budget
    truncated_text = page_text[:8000] if page_text else ""

    user_content = (
        f"## Extracted metrics (JSON)\n{metrics_json}\n\n"
        f"## Report text excerpt\n{truncated_text}"
    )

    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model=model_id,
            contents=user_content,
            config=genai_types.GenerateContentConfig(
                system_instruction=DIGEST_PROMPT,
                temperature=0.2,
            ),
        )
        raw = response.text.strip()

        # Strip markdown fences if present
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        raw = raw.strip()

        parsed = json.loads(raw)
        return {
            "digest": str(parsed.get("digest", "")),
            "confidence": float(parsed.get("confidence", 0.0)),
            "key_takeaways": list(parsed.get("key_takeaways", [])),
        }
    except json.JSONDecodeError as e:
        log.warning("  Digest JSON parse failed: %s — raw: %.200s", e, raw if "raw" in dir() else "")
        return {"digest": "", "confidence": 0.0, "key_takeaways": []}
    except Exception as e:
        log.warning("  Digest generation failed: %s", e)
        return {"digest": "", "confidence": 0.0, "key_takeaways": []}


def upload_raw_text_to_gcs(stock_code: str, report_url: str, text: str) -> Optional[str]:
    """Upload raw page text to GCS and return the gs:// URI.

    Bucket: shorted-financial-reports (from env GCS_REPORTS_BUCKET or default).
    Object path: digests/<stock_code>/<sha1-of-report_url>.txt

    Returns the gs:// URI on success, None on failure (best-effort — never raises).
    """
    bucket_name = os.environ.get("GCS_REPORTS_BUCKET", "shorted-financial-reports")
    url_sha1 = hashlib.sha1(report_url.encode()).hexdigest()
    blob_path = f"digests/{stock_code}/{url_sha1}.txt"
    gcs_uri = f"gs://{bucket_name}/{blob_path}"

    try:
        from google.cloud import storage as gcs
        client = gcs.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_path)
        blob.upload_from_string(text, content_type="text/plain; charset=utf-8")
        log.info("  Uploaded raw text to %s", gcs_uri)
        return gcs_uri
    except Exception as e:
        log.warning("  GCS upload failed (non-fatal): %s", e)
        return None


def store_extraction(conn, report: dict, metrics: dict, raw_text_length: int, dry_run: bool = False, digest_result: Optional[dict] = None, raw_text_gcs_url: Optional[str] = None):
    """Store extraction results in the database."""
    if dry_run:
        log.info("  [DRY RUN] Would store %d metrics for %s", len(metrics), report["stock_code"])
        if digest_result:
            log.info("  [DRY RUN] Digest: %.120s", digest_result.get("digest", ""))
        return

    dr = digest_result or {}
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO financial_report_extractions
            (stock_code, report_url, report_type, report_title, report_date,
             metrics, raw_text_length, extracted_at,
             digest, digest_confidence, digest_model, raw_text_gcs_url)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (report_url) DO UPDATE SET
            metrics = EXCLUDED.metrics,
            raw_text_length = EXCLUDED.raw_text_length,
            extracted_at = EXCLUDED.extracted_at,
            digest = EXCLUDED.digest,
            digest_confidence = EXCLUDED.digest_confidence,
            digest_model = EXCLUDED.digest_model,
            raw_text_gcs_url = EXCLUDED.raw_text_gcs_url
        """,
        (
            report["stock_code"],
            report["url"],
            report["type"],
            report["title"],
            report["date"],
            json.dumps(metrics),
            raw_text_length,
            datetime.utcnow(),
            dr.get("digest") or None,
            dr.get("confidence") if dr.get("confidence") is not None else None,
            DIGEST_MODEL if dr.get("digest") else None,
            raw_text_gcs_url,
        ),
    )
    conn.commit()
    cur.close()


def ensure_table(conn):
    """Create the extraction results table if it doesn't exist."""
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS financial_report_extractions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            stock_code VARCHAR(50) NOT NULL,
            report_url TEXT NOT NULL UNIQUE,
            report_type VARCHAR(50),
            report_title TEXT,
            report_date DATE,
            metrics JSONB NOT NULL DEFAULT '{}',
            raw_text_length INTEGER,
            extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_fre_stock_code ON financial_report_extractions(stock_code);
        CREATE INDEX IF NOT EXISTS idx_fre_report_date ON financial_report_extractions(report_date DESC);
        CREATE INDEX IF NOT EXISTS idx_fre_report_type ON financial_report_extractions(report_type);
        """
    )
    conn.commit()
    cur.close()


def main():
    parser = argparse.ArgumentParser(description="Extract financial data from ASX reports using langextract")
    parser.add_argument("--mode", choices=["top50", "codes", "all"], default="top50")
    parser.add_argument("--codes", type=str, default="", help="Comma-separated stock codes")
    parser.add_argument("--limit", type=int, default=0, help="Max total reports to process (0=unlimited)")
    parser.add_argument("--recent", type=int, default=0, help="Max reports per company (0=unlimited, e.g. 2=latest annual+half-year)")
    parser.add_argument("--model", type=str, default="gemini-2.5-flash", help="LLM model ID")
    parser.add_argument("--delay", type=float, default=2.0, help="Delay between PDF downloads (seconds)")
    parser.add_argument("--max-pages", type=int, default=10, help="Max PDF pages to extract text from")
    parser.add_argument("--dry-run", action="store_true", help="Don't write to database")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    codes = [c.strip().upper() for c in args.codes.split(",") if c.strip()] if args.codes else []
    mode = "codes" if codes else args.mode

    conn = get_db_connection()
    # Schema is now managed by migration 000045; ensure_table() is a no-op here.
    # ensure_table(conn)

    reports = get_reports_to_process(conn, mode, codes, args.limit, recent=args.recent)
    log.info("Found %d reports to process (mode=%s)", len(reports), mode)

    if not reports:
        log.info("Nothing to process")
        return

    # Create a shared HTTP session for PDF downloads
    session = requests.Session()
    session.headers.update(ASX_HEADERS)

    total_processed = 0
    total_extracted = 0
    total_errors = 0

    for i, report in enumerate(reports):
        if i > 0:
            time.sleep(args.delay)

        if i > 0 and i % 10 == 0:
            log.info(
                "Progress: %d/%d processed, %d extracted, %d errors",
                i,
                len(reports),
                total_extracted,
                total_errors,
            )

        log.info(
            "[%d/%d] %s: %s (%s)",
            i + 1,
            len(reports),
            report["stock_code"],
            report["title"][:60],
            report["type"],
        )

        # Step 1: Download and extract text
        text = download_pdf_text(session, report["url"], max_pages=args.max_pages)
        if not text:
            total_errors += 1
            continue

        log.info("  Extracted %d chars of text", len(text))

        # Step 2: Extract financial data with langextract
        extractions = extract_financial_data(text, report["stock_code"], model_id=args.model)
        if not extractions:
            log.info("  No financial metrics found")
            total_processed += 1
            # Still store empty result to mark as processed (no digest — nothing to summarise)
            raw_text_gcs_url = upload_raw_text_to_gcs(report["stock_code"], report["url"], text)
            store_extraction(conn, report, {}, len(text), args.dry_run, digest_result=None, raw_text_gcs_url=raw_text_gcs_url)
            continue

        # Step 3: Convert to structured metrics
        metrics = extractions_to_metrics(extractions)
        log.info("  Found %d metric types: %s", len(metrics), ", ".join(metrics.keys()))

        if args.verbose:
            for cls, mdata in metrics.items():
                if isinstance(mdata, list):
                    for d in mdata:
                        log.debug("    %s: %s", cls, d.get("source_text", "")[:80])
                else:
                    log.debug("    %s: %s", cls, mdata.get("source_text", "")[:80])

        # Step 4: Generate digest summary
        log.info("  Generating digest...")
        digest_result = summarize_report(metrics, text, model_id=args.model)
        if digest_result.get("digest"):
            log.info("  Digest (confidence=%.2f): %.120s", digest_result["confidence"], digest_result["digest"])

        # Step 5: Upload raw text to GCS (best-effort)
        raw_text_gcs_url = upload_raw_text_to_gcs(report["stock_code"], report["url"], text)

        # Step 6: Store results
        store_extraction(conn, report, metrics, len(text), args.dry_run, digest_result=digest_result, raw_text_gcs_url=raw_text_gcs_url)
        total_processed += 1
        total_extracted += 1

    log.info(
        "Done! Processed: %d, Extracted: %d, Errors: %d",
        total_processed,
        total_extracted,
        total_errors,
    )

    conn.close()


if __name__ == "__main__":
    main()
