#!/usr/bin/env python3
"""Concurrent financial-report extraction backfill.

extract.py's main() is sequential (--delay loop) — fine for a handful of stocks
but far too slow for the ~5k latest-reports-per-company backfill. This reuses
extract.py's PDF + langextract + digest helpers under a ThreadPoolExecutor so the
financial-digest coverage can be broadened from ~63 stocks to the whole market.

Two modes:
  (default)            select latest-N key reports per company that have NEVER been
                       extracted, and run the full extract+digest pipeline.
  --backfill-digests   §6.3(b): re-summarise rows ALREADY in
                       financial_report_extractions that have digest IS NULL (the
                       ~4,740 historical no-metrics rows). Prefers the raw text
                       stored in GCS so it does not re-download (older 2024 ASX URLs
                       no longer resolve); falls back to re-downloading the PDF.

Run (against prod):
  DATABASE_URL=... GEMINI_API_KEY=... LANGEXTRACT_API_KEY=$GEMINI_API_KEY \
    python extract_reports_concurrent.py --recent 2 --limit 5000 --workers 8 [--top-shorted-first]
  DATABASE_URL=... GEMINI_API_KEY=... \
    python extract_reports_concurrent.py --backfill-digests --limit 5000 --workers 8 [--top-shorted-first]

Threading note: each worker uses its own thread-local psycopg2 connection (psycopg2
connections are not thread-safe). The main thread's connection is used only for the
initial selection query.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import logging
import threading

import psycopg2
import psycopg2.extras
import requests

import extract  # reuse helpers (import is side-effect-free)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reports-backfill")

_tl = threading.local()


def _session() -> requests.Session:
    s = getattr(_tl, "session", None)
    if s is None:
        s = requests.Session()
        s.headers.update(extract.ASX_HEADERS)
        _tl.session = s
    return s


def _conn():
    """Thread-local DB connection. psycopg2 connections are NOT thread-safe, so each
    worker thread gets its own (this removes the shared-connection + lock hazard)."""
    c = getattr(_tl, "conn", None)
    if c is None:
        c = extract.get_db_connection()
        _tl.conn = c
    return c


def _apply_top_shorted_order(conn, reports: list[dict], top_shorted_first: bool) -> list[dict]:
    if not top_shorted_first:
        return reports
    cur = conn.cursor()
    cur.execute("SELECT product_code, current_percent FROM mv_top_shorts")
    rank = {code: pct for code, pct in cur.fetchall()}
    cur.close()
    reports.sort(key=lambda r: rank.get(r["stock_code"], -1), reverse=True)
    return reports


def select_reports(conn, recent: int, limit: int, top_shorted_first: bool) -> list[dict]:
    """Latest `recent` key financial reports per company, deduped vs already-extracted."""
    reports = extract.get_reports_to_process(conn, mode="all", codes=[], limit=0, recent=recent)
    reports = _apply_top_shorted_order(conn, reports, top_shorted_first)
    if limit > 0:
        reports = reports[:limit]
    return reports


def select_digestless_reports(conn, limit: int, top_shorted_first: bool) -> list[dict]:
    """§6.3(b) Rows already extracted but with NO digest yet (the historical
    no-metrics corpus). Carries the stored metrics + GCS text pointer so the digest
    can be (re)generated without re-downloading the PDF."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cur.execute(
        """
        SELECT stock_code, report_url, report_type, report_title,
               report_date::text AS report_date, metrics::text AS metrics,
               raw_text_length, raw_text_gcs_url
        FROM financial_report_extractions
        WHERE digest IS NULL
        """
    )
    rows = [dict(r) for r in cur.fetchall()]
    cur.close()
    reports = [
        {
            "stock_code": r["stock_code"],
            "url": r["report_url"],
            "type": r["report_type"],
            "title": r["report_title"] or "",
            "date": r["report_date"],
            "metrics": r["metrics"],
            "raw_text_gcs_url": r["raw_text_gcs_url"],
        }
        for r in rows
    ]
    reports = _apply_top_shorted_order(conn, reports, top_shorted_first)
    if limit > 0:
        reports = reports[:limit]
    return reports


def process(report: dict, model: str, max_pages: int, dry_run: bool) -> str:
    conn = _conn()
    text = extract.download_pdf_text(_session(), report["url"], max_pages=max_pages)
    if not text:
        return "no_pdf"
    extractions = extract.extract_financial_data(text, report["stock_code"], model_id=model)
    # GCS upload is best-effort; never fail the report on it.
    try:
        gcs_url = extract.upload_raw_text_to_gcs(report["stock_code"], report["url"], text)
    except Exception:  # noqa: BLE001
        gcs_url = None

    if not extractions:
        # §6.3(b) Decouple the digest from metric extraction: still summarise from raw
        # text (most results presentations state numbers in prose, not tables).
        digest = None
        if len(text) >= extract.MIN_DIGEST_CHARS:
            digest = extract.summarize_report({}, text, model_id=model)
        extract.store_extraction(conn, report, {}, len(text), dry_run, digest_result=digest, raw_text_gcs_url=gcs_url)
        return "digest_only" if (digest and digest.get("digest")) else "no_metrics"

    metrics = extract.extractions_to_metrics(extractions)
    digest = extract.summarize_report(metrics, text, model_id=model)
    extract.store_extraction(conn, report, metrics, len(text), dry_run, digest_result=digest, raw_text_gcs_url=gcs_url)
    return "ok"


def process_digestless(report: dict, model: str, max_pages: int, dry_run: bool) -> str:
    """Re-summarise one already-extracted row that has no digest. Prefers stored GCS
    text; only re-downloads the PDF if the text isn't in GCS."""
    import json as _json

    conn = _conn()
    gcs_url = report.get("raw_text_gcs_url")
    text = extract.download_text_from_gcs(gcs_url) if gcs_url else None
    source = "gcs"
    if not text:
        text = extract.download_pdf_text(_session(), report["url"], max_pages=max_pages)
        source = "pdf"
        # Backfill the GCS pointer if we had to re-download.
        if text and not gcs_url:
            try:
                gcs_url = extract.upload_raw_text_to_gcs(report["stock_code"], report["url"], text)
            except Exception:  # noqa: BLE001
                gcs_url = None
    if not text or len(text) < extract.MIN_DIGEST_CHARS:
        return "no_text"

    try:
        metrics = _json.loads(report.get("metrics") or "{}")
    except (ValueError, TypeError):
        metrics = {}

    digest = extract.summarize_report(metrics, text, model_id=model)
    if not (digest and digest.get("digest")):
        return "no_digest"
    extract.store_extraction(conn, report, metrics, len(text), dry_run, digest_result=digest, raw_text_gcs_url=gcs_url)
    return f"ok_{source}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--recent", type=int, default=2, help="latest N reports per company")
    ap.add_argument("--limit", type=int, default=0, help="cap total reports (0=all)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--model", type=str, default="gemini-2.5-flash")
    ap.add_argument("--max-pages", type=int, default=10)
    ap.add_argument("--top-shorted-first", action="store_true")
    ap.add_argument("--backfill-digests", action="store_true",
                    help="§6.3(b): re-summarise existing rows with digest IS NULL (uses stored GCS text)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = extract.get_db_connection()
    if args.backfill_digests:
        reports = select_digestless_reports(conn, args.limit, args.top_shorted_first)
        worker = process_digestless
        log.info("Digest backfill: %d rows with no digest (workers=%d)", len(reports), args.workers)
    else:
        reports = select_reports(conn, args.recent, args.limit, args.top_shorted_first)
        worker = process
        log.info("Report backfill: %d reports to process (recent=%d, workers=%d)", len(reports), args.recent, args.workers)

    if args.dry_run and reports:
        for r in reports[:10]:
            log.info("  [dry-run] %s %s (%s) %s", r["stock_code"], (r.get("title") or "")[:50], r.get("type"), r.get("date"))

    counts: dict[str, int] = {}
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(worker, r, args.model, args.max_pages, args.dry_run): r for r in reports}
        for fut in concurrent.futures.as_completed(futs):
            try:
                outcome = fut.result()
            except Exception as e:  # noqa: BLE001
                outcome = "error"
                log.warning("  worker error: %s", e)
            counts[outcome] = counts.get(outcome, 0) + 1
            done += 1
            if done % 50 == 0:
                log.info("  progress %d/%d  %s", done, len(reports), counts)

    log.info("DONE: %s", counts)
    conn.close()


if __name__ == "__main__":
    main()
