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

from register_parse import parse_house_document
from register_schema import (
    EXTRACTOR_NAME,
    MIN_PAGE_COVERAGE_PCT,
    SCAN_PAGE_CHAR_THRESHOLD,
    SCHEMA_VERSION,
    TIER_VISION,
    TIER_DETERMINISTIC,
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


from register_vision import (  # noqa: E402  (kept near use: agy is operator-only)
    VISION_BATCH_PAGES,
    VISION_CONCURRENCY_DEFAULT,
    GEMINI_API_MODEL_DEFAULT,
    VISION_MODEL_DEFAULT,
    VisionQuotaExhausted,
    VisionUnavailable,
    require_agy,
    vision_gates,
    vision_pages,
)


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


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def select_documents_to_extract(conn, args):
    conds = [
        "fetch_status = 'fetched'",
        "classify_status = 'classified'",
        "storage_uri IS NOT NULL",
        # Scan-only documents have nothing for the deterministic tier to read.
        # They wait for the vision tier rather than being recorded as failures.
        "text_class <> 'scan'",
    ]
    params: list = []
    if args.chamber:
        conds.append("chamber = %s")
        params.append(args.chamber)
    if args.parliament:
        conds.append("parliament = %s")
        params.append(args.parliament)
    if not args.force:
        # Re-extracting at the same version is pointless: the artifact is keyed
        # by (sha256, extractor_version, tier).
        conds.append(
            "NOT EXISTS (SELECT 1 FROM register_extractions e "
            "WHERE e.content_sha256 = register_documents.content_sha256 "
            "AND e.extractor_version = %s AND e.tier = %s)"
        )
        params.extend([SCHEMA_VERSION, TIER_DETERMINISTIC])

    sql = f"""
        SELECT id::text, source_url, storage_uri, chamber, parliament,
               content_sha256, page_count,
               COALESCE(blank_page_count, 0) AS blank_page_count,
               COALESCE(scan_page_count, 0)  AS scan_page_count
        FROM register_documents
        WHERE {' AND '.join(conds)}
        ORDER BY parliament DESC NULLS LAST, discovered_at
    """
    if args.limit > 0:
        sql += " LIMIT %s"
        params.append(args.limit)

    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    return rows


def build_artifact(row, parsed, page_count: int, tier: str = TIER_DETERMINISTIC) -> dict:
    """Serialise a parse into the versioned artifact.

    Field names mirror the DB columns the Go loader writes, so the contract
    between the two languages is one JSON shape rather than two conventions.
    """
    statements = []
    for s in parsed.statements:
        statements.append(
            {
                "ordinal": s.ordinal,
                "kind": s.kind,
                "lodged_date": s.lodged_date.isoformat() if s.lodged_date else None,
                "date_is_stated": s.date_is_stated,
                "page_from": s.page_from,
                "page_to": s.page_to,
                "warnings": s.warnings,
                "items": [
                    {
                        "item_no": item.item_no,
                        "item_label": item.item_label,
                        "page_no": item.page_no,
                        "rows": [
                            {
                                "holder": r.holder,
                                "change_type": r.change_type,
                                "ordinal": r.ordinal,
                                "declared_text": r.declared_text,
                                "declared_lines": r.declared_lines,
                                "secondary_text": r.secondary_text,
                                "tertiary_text": r.tertiary_text,
                                "is_nil": r.is_nil,
                                "contains_amount": r.contains_amount,
                                "page_no": r.page_no,
                            }
                            for r in item.rows
                        ],
                    }
                    for item in s.items
                ],
            }
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "document_sha256": row["content_sha256"],
        "source_url": row["source_url"],
        "chamber": row["chamber"],
        "parliament": row["parliament"],
        "extractor": {
            "name": EXTRACTOR_NAME,
            "version": SCHEMA_VERSION,
            "tier": tier,
            "model": "",
        },
        "pages": {
            "count": page_count,
            "attributed": parsed.pages_attributed,
            "blank": row["blank_page_count"],
            "scan": row["scan_page_count"],
        },
        "statements": statements,
        "warnings": parsed.warnings,
    }


def artifact_metrics(artifact: dict, page_count: int, blank_pages: int = 0) -> dict:
    """Coverage is measured against READABLE pages, not every page.

    Blank continuation pages carry nothing to attribute, so counting them as
    misses drags a perfectly-parsed document under the threshold: an 8-page
    statement with one blank page scores 7/8 = 88% and would be quarantined as
    'partial' despite having lost nothing.
    """
    statements = artifact["statements"]
    items = sum(len(s["items"]) for s in statements)
    attributed = artifact["pages"]["attributed"]
    readable = max(page_count - blank_pages, 0)
    coverage = (100.0 * attributed / readable) if readable else 0.0
    return {
        "statement_count": len(statements),
        "item_count": items,
        "pages_covered": attributed,
        "readable_pages": readable,
        "page_coverage_pct": round(min(coverage, 100.0), 2),
    }


def store_extraction(
    conn, row, artifact: dict, metrics: dict, dry_run: bool,
    tier: str = TIER_DETERMINISTIC, model: str = "",
) -> None:
    if dry_run:
        return

    warnings = list(artifact.get("warnings", []))
    for s in artifact["statements"]:
        warnings.extend(s.get("warnings", []))

    # A document whose pages are mostly unattributed is 'partial' and must never
    # reach public output — silent under-extraction is indistinguishable from a
    # member who declared nothing.
    #
    # A centred-label layout is quarantined for a different reason: the rows ARE
    # extracted, but this parser cannot reliably attribute them between Self /
    # Spouse / Dependent children. Wrong attribution published under a named
    # person is far worse than a known gap.
    status = "extracted"
    if metrics["page_coverage_pct"] < MIN_PAGE_COVERAGE_PCT:
        status = "partial"
    elif any(w == "centred_label_layout" for w in warnings):
        status = "partial"

    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO register_extractions
            (document_id, content_sha256, schema_version, extractor_name,
             extractor_version, tier, model, payload, statement_count,
             item_count, pages_covered, page_coverage_pct, warnings)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (content_sha256, extractor_version, tier) DO UPDATE SET
            payload           = EXCLUDED.payload,
            statement_count   = EXCLUDED.statement_count,
            item_count        = EXCLUDED.item_count,
            pages_covered     = EXCLUDED.pages_covered,
            page_coverage_pct = EXCLUDED.page_coverage_pct,
            warnings          = EXCLUDED.warnings
        """,
        (
            row["id"],
            row["content_sha256"],
            SCHEMA_VERSION,
            EXTRACTOR_NAME,
            SCHEMA_VERSION,
            tier,
            model,
            psycopg2.extras.Json(artifact),
            metrics["statement_count"],
            metrics["item_count"],
            metrics["pages_covered"],
            metrics["page_coverage_pct"],
            psycopg2.extras.Json(warnings),
        ),
    )
    cur.execute(
        """
        UPDATE register_documents SET
            extract_status    = %s,
            extract_tier      = %s,
            extractor_version = %s,
            extracted_at      = now(),
            extract_error     = '',
            page_coverage_pct = %s,
            updated_at        = now()
        WHERE id = %s
        """,
        (status, tier, SCHEMA_VERSION, metrics["page_coverage_pct"], row["id"]),
    )
    conn.commit()
    cur.close()


def mark_extract_failed(conn, doc_id: str, err: Exception, dry_run: bool) -> None:
    if dry_run:
        return
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE register_documents SET
            extract_status = 'failed',
            extract_error  = %s,
            updated_at     = now()
        WHERE id = %s
        """,
        (str(err)[:500], doc_id),
    )
    conn.commit()
    cur.close()


def run_extract(args) -> int:
    conn = connect_db()
    rows = select_documents_to_extract(conn, args)
    if not rows:
        log.info("extract: nothing to do")
        return 0

    log.info("extract: %d documents%s", len(rows), " (dry run)" if args.dry_run else "")
    extracted = partial = failed = 0
    total_rows = 0

    for row in rows:
        temp_path = None
        try:
            doc, temp_path = open_document(row["storage_uri"])
            try:
                parsed = parse_house_document(doc)
                page_count = row["page_count"] or doc.page_count
            finally:
                doc.close()

            artifact = build_artifact(row, parsed, page_count)
            metrics = artifact_metrics(artifact, page_count, row["blank_page_count"])
            declared = sum(
                1
                for s in artifact["statements"]
                for i in s["items"]
                for r in i["rows"]
                if not r["is_nil"]
            )
            total_rows += declared

            store_extraction(conn, row, artifact, metrics, args.dry_run)
            if metrics["page_coverage_pct"] >= MIN_PAGE_COVERAGE_PCT:
                extracted += 1
            else:
                partial += 1
            log.info(
                "  %s %d statements, %d items, %d declared rows, coverage %.0f%%",
                row["source_url"].rsplit("/", 1)[-1],
                metrics["statement_count"],
                metrics["item_count"],
                declared,
                metrics["page_coverage_pct"],
            )
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("  %s FAILED: %s", row["source_url"], e)
            mark_extract_failed(conn, row["id"], e, args.dry_run)
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

    conn.close()
    log.info(
        "extract: %d extracted, %d partial, %d failed, %d declared rows",
        extracted,
        partial,
        failed,
        total_rows,
    )
    return 1 if failed and failed == len(rows) else 0



def select_documents_for_vision(conn, args):
    """Documents the deterministic tier cannot read.

    'scan' has no text layer at all; 'mixed' has some scanned pages. Both need
    the vision tier for at least part of the document.
    """
    conds = [
        "fetch_status = 'fetched'",
        "classify_status = 'classified'",
        "storage_uri IS NOT NULL",
        "text_class IN ('scan', 'mixed')",
    ]
    params: list = []
    if args.chamber:
        conds.append("chamber = %s")
        params.append(args.chamber)
    if args.parliament:
        conds.append("parliament = %s")
        params.append(args.parliament)
    if not args.force:
        conds.append(
            "NOT EXISTS (SELECT 1 FROM register_extractions e "
            "WHERE e.content_sha256 = register_documents.content_sha256 "
            "AND e.extractor_version = %s AND e.tier = %s)"
        )
        params.extend([SCHEMA_VERSION, TIER_VISION])

    sql = f"""
        SELECT id, source_url, content_sha256, storage_uri, chamber, parliament,
               page_count, blank_page_count, scan_page_count, text_class
        FROM register_documents
        WHERE {" AND ".join(conds)}
        ORDER BY parliament DESC NULLS LAST, source_url
    """
    if args.limit:
        sql += f" LIMIT {int(args.limit)}"

    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    return rows


def run_vision(args) -> int:
    """Read scanned documents through the agy-backed vision tier.

    OPERATOR-MACHINE ONLY. `agy` authenticates as the operator, so this stage
    needs no GEMINI_API_KEY — and cannot run in the report-extractor container,
    which has no agy binary. require_agy() fails fast rather than marking a whole
    batch as failed extractions.
    """
    if args.vision_backend == "agy":
        try:
            require_agy()
        except VisionUnavailable as e:
            log.error("vision: %s", e)
            return 2
    elif not os.environ.get("GEMINI_API_KEY", "").strip():
        log.error("vision: --vision-backend gemini-api needs GEMINI_API_KEY")
        return 2

    conn = connect_db()
    rows = select_documents_for_vision(conn, args)
    if not rows:
        log.info("vision: nothing to do")
        return 0

    log.info(
        "vision: %d documents, backend=%s model=%s batch=%d concurrency=%d%s",
        len(rows), args.vision_backend, args.model, args.batch_pages, args.concurrency,
        " (dry run)" if args.dry_run else "",
    )

    extracted = partial = failed = 0
    total_rows = 0

    for row in rows:
        temp_path = None
        try:
            doc, temp_path = open_document(row["storage_uri"])
            try:
                page_count = row["page_count"] or doc.page_count
            finally:
                doc.close()

            # open_document returns temp_path=None for a file:// URI — the bytes
            # were never downloaded. Rasterising needs a real path either way.
            uri = row["storage_uri"]
            pdf_path = temp_path or (
                uri[len("file://"):] if uri.startswith("file://") else uri
            )

            # Every page goes to vision. Choosing pages by char count would skip
            # a scanned page that happens to carry a stray text artefact, and a
            # skipped page is an unread declaration.
            pages = list(range(1, page_count + 1))

            parsed = vision_pages(
                pdf_path,
                page_numbers=pages,
                page_count=page_count,
                model=args.model,
                batch_size=args.batch_pages,
                concurrency=args.concurrency,
                backend=args.vision_backend,
            )
            gates = vision_gates(parsed)
            parsed.warnings.extend(gates)

            artifact = build_artifact(row, parsed, page_count, tier=TIER_VISION)
            metrics = artifact_metrics(artifact, page_count, row["blank_page_count"])
            declared = sum(
                1
                for s in artifact["statements"]
                for i in s["items"]
                for r in i["rows"]
                if not r["is_nil"]
            )
            total_rows += declared

            store_extraction(
                conn, row, artifact, metrics, args.dry_run,
                tier=TIER_VISION, model=args.model,
            )
            ok = metrics["page_coverage_pct"] >= MIN_PAGE_COVERAGE_PCT and not gates
            if ok:
                extracted += 1
            else:
                partial += 1
            log.info(
                "  %s %d items, %d declared rows, coverage %.0f%%%s",
                row["source_url"].rsplit("/", 1)[-1],
                metrics["item_count"],
                declared,
                metrics["page_coverage_pct"],
                (" GATES: " + ",".join(gates)) if gates else "",
            )
        except VisionQuotaExhausted as e:
            # Terminal for the RUN. Stop immediately rather than grinding the rest
            # of the queue into 0%-coverage partials that look like unreadable
            # scans. The queue is resumable: no artifact was written for this
            # document, so a later run picks it up with no --force.
            failed += 1
            log.error("  %s quota exhausted: %s", row["source_url"], e)
            mark_extract_failed(conn, row["id"], e, args.dry_run)
            log.error(
                "vision: ABORTING — agy subscription quota is spent. "
                "%d extracted, %d partial, %d failed so far. Re-run after the "
                "quota resets; completed documents are skipped automatically.",
                extracted, partial, failed,
            )
            break
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("  %s FAILED: %s", row["source_url"], e)
            mark_extract_failed(conn, row["id"], e, args.dry_run)
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

    conn.close()
    log.info(
        "vision: %d extracted, %d partial, %d failed, %d declared rows",
        extracted, partial, failed, total_rows,
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Register-of-interests extraction")
    ap.add_argument("--stage", choices=["classify", "extract", "vision"], required=True)
    ap.add_argument("--limit", type=int, default=0, help="0 = no cap")
    ap.add_argument("--chamber", choices=["house", "senate"])
    ap.add_argument("--parliament", type=int)
    ap.add_argument("--force", action="store_true", help="re-extract at the same version")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--model", default="", help="vision model; defaults per backend")
    ap.add_argument(
        "--batch-pages", type=int, default=VISION_BATCH_PAGES,
        help="pages per agy call (batching is the throughput lever, not concurrency)",
    )
    ap.add_argument(
        "--concurrency", type=int, default=VISION_CONCURRENCY_DEFAULT,
        help="parallel calls; clamped to the measured ceiling of 8",
    )
    ap.add_argument(
        "--vision-backend", choices=["agy", "gemini-api"], default="agy",
        help="agy CLI (operator auth, quota-limited) or the Gemini API (needs GEMINI_API_KEY)",
    )
    args = ap.parse_args()

    if args.stage == "classify":
        return run_classify(args)
    if args.stage == "vision":
        if not args.model:
            args.model = (
                GEMINI_API_MODEL_DEFAULT
                if args.vision_backend == "gemini-api"
                else VISION_MODEL_DEFAULT
            )
        return run_vision(args)
    return run_extract(args)


if __name__ == "__main__":
    sys.exit(main())
