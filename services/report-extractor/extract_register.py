#!/usr/bin/env python3
"""Register-of-interests extraction entrypoint.

Stages:

    --stage classify   Open each fetched PDF, measure extractable text per page,
                       and record page_count / chars_per_page / text_class /
                       scan_page_count on the manifest. No LLM, no network
                       beyond reading the stored object.

    --stage extract    (phase 3) Parse documents into the versioned JSON
                       artifact.

The Go collector owns crawling, the manifest and entity resolution; this owns
PDF -> JSON. They meet at register_extractions plus the status columns on
register_documents. Go never parses a PDF, which is why page classification
lives here rather than at fetch time.

Design notes: docs/politician-register-architecture.md
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
from dataclasses import dataclass
from typing import Optional

import fitz  # pymupdf
import psycopg2
import psycopg2.extras

from register_schema import (
    SCAN_PAGE_CHAR_THRESHOLD,
    classify_document,
    classify_page,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("extract_register")


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def open_document(storage_uri: str) -> tuple[fitz.Document, Optional[str]]:
    """Open a stored PDF from a file:// or gs:// URI.

    Returns (document, temp_path). temp_path is set only when the bytes were
    downloaded and must be cleaned up by the caller.
    """
    if not storage_uri:
        raise ValueError("document has no storage_uri (was it fetched?)")

    if storage_uri.startswith("file://"):
        return fitz.open(storage_uri[len("file://") :]), None

    if storage_uri.startswith("gs://"):
        from google.cloud import storage as gcs

        without_scheme = storage_uri[len("gs://") :]
        bucket_name, _, blob_path = without_scheme.partition("/")
        if not bucket_name or not blob_path:
            raise ValueError(f"malformed gs:// URI: {storage_uri}")

        client = gcs.Client()
        blob = client.bucket(bucket_name).blob(blob_path)
        # Stream to a temp file rather than into memory: in-window Senate
        # volumes reach 33MB and download_as_bytes would hold the lot.
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            blob.download_to_file(tmp)
            temp_path = tmp.name
        return fitz.open(temp_path), temp_path

    raise ValueError(f"unsupported storage_uri scheme: {storage_uri}")


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


@dataclass
class Classification:
    page_count: int
    page_chars: list[int]
    page_kinds: list[str]
    text_chars_total: int
    chars_per_page: float
    text_class: str
    scan_page_count: int
    blank_page_count: int


def page_image_coverage(page: fitz.Page) -> float:
    """Largest single image's share of the page area.

    Used to tell a scanned page (full-bleed raster) from a blank continuation
    page in a born-digital statement (which still carries the letterhead image,
    at ~0.84 coverage).
    """
    area = abs(page.rect.width * page.rect.height)
    if area <= 0:
        return 0.0
    coverage = 0.0
    for img in page.get_images(full=True):
        for rect in page.get_image_rects(img[0]):
            coverage = max(coverage, abs(rect.width * rect.height) / area)
    return coverage


def page_text_block_count(page: fitz.Page) -> int:
    """Number of rendered text blocks. Zero means no glyphs at all — a scan."""
    return sum(1 for b in page.get_text("dict").get("blocks", []) if b.get("type") == 0)


def classify_pdf(doc: fitz.Document) -> Classification:
    """Measure per-page readability.

    Whitespace is stripped before counting so a page of layout padding cannot
    masquerade as text — a scanned page still often carries a handful of stray
    OCR characters, and counting raw length would inflate it above the
    threshold.
    """
    page_chars: list[int] = []
    page_kinds: list[str] = []

    for page in doc:
        chars = len("".join((page.get_text() or "").split()))
        page_chars.append(chars)
        if chars >= SCAN_PAGE_CHAR_THRESHOLD:
            # Cheap path: a readable page needs no image inspection.
            page_kinds.append(classify_page(chars))
            continue
        page_kinds.append(
            classify_page(chars, page_image_coverage(page), page_text_block_count(page))
        )

    total = sum(page_chars)
    count = len(page_chars)
    text_class, scan_pages, blank_pages = classify_document(page_kinds)
    return Classification(
        page_count=count,
        page_chars=page_chars,
        page_kinds=page_kinds,
        text_chars_total=total,
        chars_per_page=(total / count) if count else 0.0,
        text_class=text_class,
        scan_page_count=scan_pages,
        blank_page_count=blank_pages,
    )


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


def connect_db():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL environment variable required")
        sys.exit(1)
    return psycopg2.connect(db_url)


def select_documents_to_classify(conn, limit: int, chamber: Optional[str], parliament: Optional[int]):
    conds = ["fetch_status = 'fetched'", "classify_status = 'pending'", "storage_uri IS NOT NULL"]
    args: list = []
    if chamber:
        conds.append("chamber = %s")
        args.append(chamber)
    if parliament:
        conds.append("parliament = %s")
        args.append(parliament)

    sql = f"""
        SELECT id::text, source_url, storage_uri, chamber, parliament
        FROM register_documents
        WHERE {' AND '.join(conds)}
        ORDER BY parliament DESC NULLS LAST, discovered_at
    """
    if limit > 0:
        sql += " LIMIT %s"
        args.append(limit)

    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cur.execute(sql, args)
    rows = cur.fetchall()
    cur.close()
    return rows


def store_classification(conn, doc_id: str, c: Classification, dry_run: bool) -> None:
    if dry_run:
        return
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE register_documents SET
            classify_status  = 'classified',
            page_count       = %s,
            text_chars_total = %s,
            chars_per_page   = %s,
            text_class       = %s,
            scan_page_count  = %s,
            blank_page_count = %s,
            updated_at       = now()
        WHERE id = %s
        """,
        (
            c.page_count,
            c.text_chars_total,
            round(c.chars_per_page, 2),
            c.text_class,
            c.scan_page_count,
            c.blank_page_count,
            doc_id,
        ),
    )
    conn.commit()
    cur.close()


def mark_classify_failed(conn, doc_id: str, err: Exception, dry_run: bool) -> None:
    if dry_run:
        return
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE register_documents SET
            classify_status = 'failed',
            extract_error   = %s,
            updated_at      = now()
        WHERE id = %s
        """,
        (str(err)[:500], doc_id),
    )
    conn.commit()
    cur.close()


# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------


def run_classify(args) -> int:
    conn = connect_db()
    rows = select_documents_to_classify(conn, args.limit, args.chamber, args.parliament)
    if not rows:
        log.info("classify: nothing to do")
        return 0

    log.info("classify: %d documents%s", len(rows), " (dry run)" if args.dry_run else "")
    tally = {"text": 0, "scan": 0, "mixed": 0}
    failed = 0
    total_pages = 0

    for row in rows:
        temp_path = None
        try:
            doc, temp_path = open_document(row["storage_uri"])
            try:
                c = classify_pdf(doc)
            finally:
                doc.close()

            store_classification(conn, row["id"], c, args.dry_run)
            tally[c.text_class] = tally.get(c.text_class, 0) + 1
            total_pages += c.page_count
            log.info(
                "  %s p=%d chars/pg=%.0f -> %s (%d scan, %d blank)",
                row["source_url"].rsplit("/", 1)[-1],
                c.page_count,
                c.chars_per_page,
                c.text_class,
                c.scan_page_count,
                c.blank_page_count,
            )
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("  %s FAILED: %s", row["source_url"], e)
            mark_classify_failed(conn, row["id"], e, args.dry_run)
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

    conn.close()
    log.info(
        "classify: %d text, %d mixed, %d scan, %d failed across %d pages",
        tally.get("text", 0),
        tally.get("mixed", 0),
        tally.get("scan", 0),
        failed,
        total_pages,
    )
    # A wholly failed batch is a real failure; a partial one is not.
    return 1 if failed and failed == len(rows) else 0


def run_extract(args) -> int:
    log.error("--stage extract is not implemented yet (phase 3)")
    return 2


def main() -> int:
    ap = argparse.ArgumentParser(description="Register-of-interests extraction")
    ap.add_argument("--stage", choices=["classify", "extract"], required=True)
    ap.add_argument("--limit", type=int, default=0, help="0 = no cap")
    ap.add_argument("--chamber", choices=["house", "senate"])
    ap.add_argument("--parliament", type=int)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.stage == "classify":
        return run_classify(args)
    return run_extract(args)


if __name__ == "__main__":
    sys.exit(main())
